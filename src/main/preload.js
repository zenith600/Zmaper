'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('zmaper', {
  listDisplays: () => ipcRenderer.invoke('displays:list'),
  openOutput: (displayId) => ipcRenderer.invoke('output:open', displayId),
  closeOutput: () => ipcRenderer.invoke('output:close'),
  isOutputOpen: () => ipcRenderer.invoke('output:isOpen'),

  pickMedia: () => ipcRenderer.invoke('dialog:openMedia'),

  // Electron 32 removed File.path; this is the supported replacement and is
  // the only way a drag-and-drop in the renderer can learn a real disk path.
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
  resolveMedia: (paths) => ipcRenderer.invoke('media:resolve', paths),

  saveProject: (data, saveAs) => ipcRenderer.invoke('project:save', { data, saveAs }),
  openProject: () => ipcRenderer.invoke('project:open'),
  newProject: () => ipcRenderer.invoke('project:new'),
  fileExists: (p) => ipcRenderer.invoke('fs:exists', p),

  // Mobile remote
  remoteStart: (port) => ipcRenderer.invoke('remote:start', port),
  remoteStop: () => ipcRenderer.invoke('remote:stop'),
  remoteInfo: () => ipcRenderer.invoke('remote:info'),
  remoteRotateToken: () => ipcRenderer.invoke('remote:rotateToken'),
  remoteQr: (text) => ipcRenderer.invoke('remote:qr', text),
  remoteBroadcast: (message) => ipcRenderer.send('remote:broadcast', message),

  // Editor -> output
  send: (message) => ipcRenderer.send('sync', message),
  // Output -> editor
  report: (message) => ipcRenderer.send('output:report', message),

  on: (channel, handler) => {
    const allowed = [
      'sync',
      'output:state',
      'output:report',
      'displays:changed',
      'remote:command',
      'remote:clients'
    ];
    if (!allowed.includes(channel)) return () => {};
    const wrapped = (_e, payload) => handler(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  }
});
