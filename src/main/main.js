'use strict';

const { app, BrowserWindow, ipcMain, dialog, screen, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { RemoteServer, qrMatrix } = require('./remote');

const IS_DEV = process.argv.includes('--dev');

// On a single-display machine the fullscreen output window completely covers
// the editor. Windows then reports the editor as occluded and Chromium
// suspends its renderer - including the media pipeline, so a looping video
// reaches its end and never completes the seek back to zero. Both windows then
// hitch at every loop boundary. These switches keep covered windows live, and
// must be set before the app is ready.
// The output window never receives a click, so anything Chromium gates behind
// a user gesture would never start there.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// The editor and the output decode the same clip at once. Intel's hardware
// decoder has few sessions, and re-initialising one while another is live -
// which is exactly what a loop wrap does - took ~3s, freezing the projector at
// every loop. Software decode has no such limit and loops cleanly.
app.commandLine.appendSwitch('disable-accelerated-video-decode');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

/** @type {BrowserWindow|null} */
let editorWin = null;
/** @type {BrowserWindow|null} */
let outputWin = null;

/** Last known project path, used for Save vs Save As. */
let currentProjectPath = null;

const remote = new RemoteServer(path.join(__dirname, '..', 'renderer'));
remote.onCommand = (msg) => notifyEditor('remote:command', msg);
remote.onClientsChanged = (count) => notifyEditor('remote:clients', { clients: count });

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

function createEditorWindow() {
  editorWin = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#141518',
    title: 'Zmaper',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  editorWin.loadFile(path.join(__dirname, '..', 'renderer', 'editor', 'index.html'));
  editorWin.once('ready-to-show', () => editorWin.show());
  if (IS_DEV) editorWin.webContents.openDevTools({ mode: 'detach' });

  editorWin.on('closed', () => {
    editorWin = null;
    if (outputWin && !outputWin.isDestroyed()) outputWin.close();
  });
}

/**
 * Opens (or moves) the fullscreen output window on the given display.
 * Passing displayId === null closes the output.
 */
function openOutputWindow(displayId) {
  const displays = screen.getAllDisplays();
  const target =
    displays.find((d) => d.id === displayId) ||
    displays.find((d) => d.id !== screen.getPrimaryDisplay().id) ||
    screen.getPrimaryDisplay();

  if (outputWin && !outputWin.isDestroyed()) {
    moveOutputToDisplay(target);
    outputWin.focus();
    return target.id;
  }

  outputWin = new BrowserWindow({
    x: target.bounds.x,
    y: target.bounds.y,
    width: target.bounds.width,
    height: target.bounds.height,
    frame: false,
    backgroundColor: '#000000',
    title: 'Zmaper - Output',
    fullscreenable: true,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  outputWin.loadFile(path.join(__dirname, '..', 'renderer', 'output', 'output.html'));
  outputWin.setMenu(null);

  outputWin.once('ready-to-show', () => {
    outputWin.show();
    moveOutputToDisplay(target);
    notifyEditor('output:state', { open: true, displayId: target.id });
  });

  // Esc closes the output so a fullscreen window can never trap the user.
  outputWin.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      event.preventDefault();
      outputWin.close();
    }
  });

  outputWin.on('closed', () => {
    outputWin = null;
    notifyEditor('output:state', { open: false, displayId: null });
  });

  return target.id;
}

function moveOutputToDisplay(display) {
  if (!outputWin || outputWin.isDestroyed()) return;
  outputWin.setFullScreen(false);
  outputWin.setBounds(display.bounds);
  // setSimpleFullScreen keeps the window borderless and exactly on one display,
  // which is what a projector feed needs. Real fullscreen can migrate displays.
  outputWin.setAlwaysOnTop(true, 'screen-saver');
  outputWin.setBounds(display.bounds);
}

function notifyEditor(channel, payload) {
  if (editorWin && !editorWin.isDestroyed()) editorWin.webContents.send(channel, payload);
}

function serializeDisplays() {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    index: i,
    label: `Display ${i + 1} - ${d.size.width}x${d.size.height}${d.id === primaryId ? ' (primary)' : ''}`,
    width: d.size.width,
    height: d.size.height,
    scaleFactor: d.scaleFactor,
    primary: d.id === primaryId
  }));
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle('displays:list', () => serializeDisplays());

ipcMain.handle('output:open', (_e, displayId) => openOutputWindow(displayId));

ipcMain.handle('output:close', () => {
  if (outputWin && !outputWin.isDestroyed()) outputWin.close();
  return true;
});

ipcMain.handle('output:isOpen', () => !!(outputWin && !outputWin.isDestroyed()));

// Editor -> output broadcast (project state, transport commands, time sync).
ipcMain.on('sync', (_e, message) => {
  if (outputWin && !outputWin.isDestroyed()) outputWin.webContents.send('sync', message);
});

// Output -> editor (ready handshake, fps reports).
ipcMain.on('output:report', (_e, message) => notifyEditor('output:report', message));

const VIDEO_EXTS = ['mp4', 'webm', 'mov', 'm4v', 'ogv'];
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'];
const MEDIA_EXTS = [...VIDEO_EXTS, ...IMAGE_EXTS];

function describeMediaFile(p) {
  const ext = path.extname(p).toLowerCase().replace('.', '');
  return {
    path: p,
    url: pathToFileUrl(p),
    name: path.basename(p),
    ext,
    kind: VIDEO_EXTS.includes(ext) ? 'video' : 'image'
  };
}

ipcMain.handle('dialog:openMedia', async () => {
  const res = await dialog.showOpenDialog(editorWin, {
    title: 'Add media',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Media', extensions: MEDIA_EXTS },
      { name: 'Video', extensions: VIDEO_EXTS },
      { name: 'Images', extensions: IMAGE_EXTS },
      { name: 'All files', extensions: ['*'] }
    ]
  });
  if (res.canceled) return [];
  return res.filePaths.map(describeMediaFile);
});

/**
 * Turns dropped paths into media descriptors. Unsupported files are dropped
 * silently; a dropped folder contributes the media files directly inside it.
 */
ipcMain.handle('media:resolve', (_e, paths) => {
  const out = [];
  const seen = new Set();

  const consider = (p) => {
    const ext = path.extname(p).toLowerCase().replace('.', '');
    if (!MEDIA_EXTS.includes(ext) || seen.has(p)) return;
    seen.add(p);
    out.push(describeMediaFile(p));
  };

  for (const p of paths || []) {
    try {
      if (fs.statSync(p).isDirectory()) {
        for (const name of fs.readdirSync(p).sort()) {
          const child = path.join(p, name);
          try {
            if (fs.statSync(child).isFile()) consider(child);
          } catch {
            /* unreadable entry; skip it */
          }
        }
      } else {
        consider(p);
      }
    } catch {
      /* path vanished between drop and resolve */
    }
  }
  return out;
});

ipcMain.handle('project:save', async (_e, { data, saveAs }) => {
  let target = currentProjectPath;
  if (saveAs || !target) {
    const res = await dialog.showSaveDialog(editorWin, {
      title: 'Save project',
      defaultPath: target || path.join(app.getPath('documents'), 'untitled.zmap'),
      filters: [{ name: 'Zmaper project', extensions: ['zmap'] }]
    });
    if (res.canceled) return { ok: false, canceled: true };
    target = res.filePath;
  }
  try {
    fs.writeFileSync(target, JSON.stringify(data, null, 2), 'utf8');
    currentProjectPath = target;
    if (editorWin) editorWin.setTitle(`Zmaper - ${path.basename(target)}`);
    return { ok: true, path: target, name: path.basename(target) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('project:open', async () => {
  const res = await dialog.showOpenDialog(editorWin, {
    title: 'Open project',
    properties: ['openFile'],
    filters: [{ name: 'Zmaper project', extensions: ['zmap', 'prism', 'json'] }]
  });
  if (res.canceled) return { ok: false, canceled: true };
  const target = res.filePaths[0];
  try {
    const data = JSON.parse(fs.readFileSync(target, 'utf8'));
    currentProjectPath = target;
    if (editorWin) editorWin.setTitle(`Zmaper - ${path.basename(target)}`);
    return { ok: true, path: target, name: path.basename(target), data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('project:new', () => {
  currentProjectPath = null;
  if (editorWin) editorWin.setTitle('Zmaper');
  return true;
});

// ---- Mobile remote ---------------------------------------------------------

function withQr(info) {
  return { ...info, qr: info.url ? qrMatrix(info.url) : null };
}

ipcMain.handle('remote:start', async (_e, port) => {
  try {
    return { ok: true, info: withQr(await remote.start(port || 7777)) };
  } catch (err) {
    return { ok: false, error: err.message, info: withQr(remote.info()) };
  }
});

ipcMain.handle('remote:stop', async () => ({ ok: true, info: withQr(await remote.stop()) }));
ipcMain.handle('remote:info', () => withQr(remote.info()));
ipcMain.handle('remote:rotateToken', () => withQr(remote.rotateToken()));
ipcMain.handle('remote:qr', (_e, text) => qrMatrix(text));

// Editor -> every connected phone.
ipcMain.on('remote:broadcast', (_e, message) => remote.broadcast(message));

ipcMain.handle('fs:exists', (_e, p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
});

function pathToFileUrl(p) {
  // Electron's renderer loads from file://, so media needs a proper file URL.
  let normalized = p.replace(/\\/g, '/');
  if (!normalized.startsWith('/')) normalized = '/' + normalized;
  return 'file://' + encodeURI(normalized).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createEditorWindow();

  screen.on('display-added', () => notifyEditor('displays:changed', serializeDisplays()));
  screen.on('display-removed', () => notifyEditor('displays:changed', serializeDisplays()));
  screen.on('display-metrics-changed', () => notifyEditor('displays:changed', serializeDisplays()));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createEditorWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // Release the port so a restart does not land on 7778, 7779, ...
  remote.stop().catch(() => {});
});
