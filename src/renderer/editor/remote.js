'use strict';

import { makeSurface, surfacePoints } from '../core/state.js';

/**
 * Phone remote: the editor half.
 *
 * Broadcasts a trimmed view of the project to connected phones, applies the
 * commands they send back, and draws the QR code panel. The desktop app stays
 * the single source of truth - a phone never holds authoritative state.
 */

const $ = (id) => document.getElementById(id);

const PREVIEW_FPS = 4;
const PREVIEW_WIDTH = 512;

export function initRemote(app) {
  const ui = {
    info: { running: false, addresses: [], url: null, qr: null, clients: 0, port: 0 },
    selectedAddress: null,
    port: 7777,
    previewWanted: false,
    error: null
  };

  // -- payload ------------------------------------------------------------

  /** Local file paths are of no use to a phone, so they are left out. */
  function payload() {
    return {
      type: 'state',
      output: {
        width: app.project.output.width,
        height: app.project.output.height,
        brightness: app.project.output.brightness
      },
      media: app.project.media.map((m) => ({ id: m.id, name: m.name, kind: m.kind })),
      surfaces: app.project.surfaces,
      selectedId: app.selectedId,
      outputOpen: app.outputOpen
    };
  }

  let queued = false;
  function broadcastState() {
    if (!ui.info.running || queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      window.zmaper.remoteBroadcast(payload());
    });
  }

  // Commits drive most updates, but selection and output changes do not all go
  // through commit(). A slow heartbeat guarantees a phone is never left stale.
  setInterval(() => {
    if (ui.info.running && ui.info.clients) window.zmaper.remoteBroadcast(payload());
  }, 400);

  // -- preview streaming --------------------------------------------------

  const previewCanvas = document.createElement('canvas');
  const previewCtx = previewCanvas.getContext('2d');
  let lastCapture = 0;

  /**
   * Grabs a downscaled JPEG of the output preview.
   *
   * This MUST be called from inside the render loop, immediately after
   * renderer.render(). The WebGL context has no preserveDrawingBuffer, so the
   * drawing buffer is only readable within the frame that drew it - a timer
   * firing in a later task reads an empty buffer and streams black.
   */
  function capturePreview() {
    if (!ui.info.running || !ui.previewWanted || !ui.info.clients) return;

    const now = performance.now();
    if (now - lastCapture < 1000 / PREVIEW_FPS) return;
    lastCapture = now;

    const src = $('gl');
    if (!src.width) return;

    const w = PREVIEW_WIDTH;
    const h = Math.max(1, Math.round((src.height / src.width) * w));
    if (previewCanvas.width !== w || previewCanvas.height !== h) {
      previewCanvas.width = w;
      previewCanvas.height = h;
    }
    try {
      previewCtx.drawImage(src, 0, 0, w, h);
      window.zmaper.remoteBroadcast({
        type: 'preview',
        image: previewCanvas.toDataURL('image/jpeg', 0.5)
      });
    } catch {
      /* transient readback failure; the next frame will carry one */
    }
  }

  // -- commands from a phone ---------------------------------------------

  /** Geometry captured at gesture start, so drags survive dropped packets. */
  let gestureOrigin = null;

  function surfaceById(id) {
    return app.project.surfaces.find((s) => s.id === id) || null;
  }

  function setByPath(target, path, value) {
    const keys = path.split('.');
    let node = target;
    for (let i = 0; i < keys.length - 1; i++) {
      if (node[keys[i]] === undefined || node[keys[i]] === null) return false;
      node = node[keys[i]];
    }
    node[keys[keys.length - 1]] = value;
    return true;
  }

  function applyCommand(cmd) {
    if (!cmd || typeof cmd !== 'object') return;
    const s = cmd.id ? surfaceById(cmd.id) : null;

    switch (cmd.t) {
      case 'begin':
        if (!s || s.locked) return;
        app.pushUndo();
        gestureOrigin = { id: s.id, points: surfacePoints(s).map((p) => ({ ...p })) };
        return;

      case 'point': {
        if (!s || s.locked) return;
        const pts = surfacePoints(s);
        if (cmd.index < 0 || cmd.index >= pts.length) return;
        if (!Number.isFinite(cmd.x) || !Number.isFinite(cmd.y)) return;
        pts[cmd.index] = { x: cmd.x, y: cmd.y };
        break;
      }

      case 'moveTo': {
        if (!s || s.locked) return;
        if (!gestureOrigin || gestureOrigin.id !== s.id) return;
        if (!Number.isFinite(cmd.dx) || !Number.isFinite(cmd.dy)) return;
        const pts = surfacePoints(s);
        for (let i = 0; i < pts.length && i < gestureOrigin.points.length; i++) {
          pts[i].x = gestureOrigin.points[i].x + cmd.dx;
          pts[i].y = gestureOrigin.points[i].y + cmd.dy;
        }
        break;
      }

      case 'nudge': {
        if (!s || s.locked) return;
        if (!Number.isFinite(cmd.dx) || !Number.isFinite(cmd.dy)) return;
        app.pushUndo();
        const pts = surfacePoints(s);
        if (cmd.index === null || cmd.index === undefined) {
          for (const p of pts) {
            p.x += cmd.dx;
            p.y += cmd.dy;
          }
        } else if (cmd.index >= 0 && cmd.index < pts.length) {
          pts[cmd.index].x += cmd.dx;
          pts[cmd.index].y += cmd.dy;
        }
        break;
      }

      case 'select':
        app.selectedId = surfaceById(cmd.id) ? cmd.id : null;
        app.selectedHandles.clear();
        app.selectedMaskPoints.clear();
        app.refreshLists();
        app.rebuildInspector();
        break;

      case 'toggle': {
        if (!s) return;
        if (!['visible', 'solo', 'locked'].includes(cmd.key)) return;
        app.pushUndo();
        s[cmd.key] = !s[cmd.key];
        app.refreshLists();
        app.rebuildInspector();
        break;
      }

      case 'assign': {
        if (!s) return;
        if (cmd.mediaId && !app.project.media.some((m) => m.id === cmd.mediaId)) return;
        app.pushUndo();
        s.mediaId = cmd.mediaId || null;
        app.refreshLists();
        app.rebuildInspector();
        break;
      }

      case 'set': {
        if (!Number.isFinite(cmd.value)) return;
        const target = cmd.id ? s : app.project;
        if (!target) return;
        if (!setByPath(target, cmd.path, cmd.value)) return;
        app.rebuildInspector();
        break;
      }

      case 'addSurface': {
        app.pushUndo();
        const next = makeSurface(cmd.kind === 'mesh' ? 'mesh' : 'quad', app.project.surfaces.length, {
          mediaId: app.project.media[0]?.id || null
        });
        app.project.surfaces.push(next);
        app.selectedId = next.id;
        app.refreshLists();
        app.rebuildInspector();
        break;
      }

      case 'transport':
        app.transport(cmd.action);
        return broadcastState();

      case 'output':
        app.setOutputOpen(!!cmd.on);
        return;

      case 'undo':
        app.undo();
        return;

      case 'preview':
        ui.previewWanted = !!cmd.on;
        return;

      default:
        return;
    }

    app.commit();
  }

  // -- QR panel -----------------------------------------------------------

  function drawQr(matrix) {
    const cell = 6;
    const quiet = 2;
    const size = (matrix.size + quiet * 2) * cell;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const c = canvas.getContext('2d');
    c.fillStyle = '#fff';
    c.fillRect(0, 0, size, size);
    c.fillStyle = '#000';
    for (let r = 0; r < matrix.size; r++) {
      for (let col = 0; col < matrix.size; col++) {
        if (matrix.rows[r][col] === '1') {
          c.fillRect((col + quiet) * cell, (r + quiet) * cell, cell, cell);
        }
      }
    }
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    return canvas;
  }

  function el(tag, attrs = {}, kids = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(kids)) if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return n;
  }

  async function activeUrl() {
    if (!ui.info.running) return null;
    const chosen =
      ui.info.addresses.find((a) => a.address === ui.selectedAddress) || ui.info.addresses[0];
    return chosen ? chosen.url : null;
  }

  async function renderPanel() {
    const body = $('remote-body');
    body.innerHTML = '';

    // --- controls
    const portInput = el('input', { type: 'number', min: 1024, max: 65535, value: ui.port });
    portInput.style.width = '92px';
    portInput.addEventListener('change', () => {
      const v = parseInt(portInput.value, 10);
      if (Number.isFinite(v)) ui.port = Math.min(65535, Math.max(1024, v));
    });
    portInput.disabled = ui.info.running;

    const toggle = el('button', {
      class: ui.info.running ? 'btn primary live' : 'btn primary',
      text: ui.info.running ? 'Stop server' : 'Start server',
      onClick: async () => {
        if (ui.info.running) {
          const res = await window.zmaper.remoteStop();
          ui.info = res.info;
          ui.error = null;
          ui.previewWanted = false;
        } else {
          const res = await window.zmaper.remoteStart(ui.port);
          ui.info = res.info;
          ui.error = res.ok ? null : res.error;
          if (res.ok) {
            ui.selectedAddress = ui.info.addresses[0]?.address || null;
            ui.port = ui.info.port;
            broadcastState();
          }
        }
        renderPanel();
      }
    });

    body.appendChild(
      el('div', { class: 'field' }, [
        el('label', { text: 'Port' }),
        el('div', { class: 'ctl' }, [portInput, toggle])
      ])
    );

    if (ui.error) {
      body.appendChild(el('div', { class: 'warn-box', text: ui.error }));
    }

    if (!ui.info.running) {
      body.appendChild(
        el('p', {
          class: 'hint',
          text: 'Start the server, then scan the QR code with a phone on the same Wi-Fi to warp surfaces, assign media and adjust edge blending while standing at the projection surface.'
        })
      );
      return;
    }

    // --- QR + details
    const url = await activeUrl();
    const qr = url ? await window.zmaper.remoteQr(url) : null;

    const info = el('div', { class: 'remote-info' }, [
      el('div', { class: 'status-line' }, [
        el('span', { class: `dot${ui.info.clients ? ' on' : ''}` }),
        el('span', {
          text: ui.info.clients
            ? `${ui.info.clients} phone${ui.info.clients === 1 ? '' : 's'} connected`
            : 'Waiting for a phone to connect'
        })
      ]),
      el('div', {
        class: 'url-box',
        text: url || 'No network address available',
        title: 'Click to copy',
        onClick: () => {
          if (!url) return;
          navigator.clipboard.writeText(url).then(
            () => app.toast('Link copied'),
            () => app.toast('Could not copy', true)
          );
        }
      })
    ]);

    if (ui.info.addresses.length > 1) {
      const list = el('div', { class: 'addr-list' });
      for (const a of ui.info.addresses) {
        list.appendChild(
          el(
            'div',
            {
              class: `addr${a.address === (ui.selectedAddress || ui.info.addresses[0].address) ? ' active' : ''}`,
              onClick: () => {
                ui.selectedAddress = a.address;
                renderPanel();
              }
            },
            [el('span', { class: 'ip', text: a.address }), el('span', { class: 'iface', text: a.name })]
          )
        );
      }
      info.appendChild(el('div', { class: 'hint', text: 'If the phone cannot connect, try another network adapter:' }));
      info.appendChild(list);
    }

    const main = el('div', { class: 'remote-main' }, [
      qr ? el('div', { class: 'qr-box' }, [drawQr(qr)]) : null,
      info
    ]);
    body.appendChild(main);

    body.appendChild(
      el('div', { class: 'btn-row' }, [
        el('button', {
          class: 'btn',
          text: 'New access key',
          title: 'Invalidates links already handed out and disconnects every phone',
          onClick: async () => {
            ui.info = await window.zmaper.remoteRotateToken();
            renderPanel();
            app.toast('New key issued - rescan the QR code');
          }
        })
      ])
    );

    body.appendChild(
      el('div', {
        class: 'warn-box',
        text: 'Anyone on this network who has the link can control the projection. The key in the link is what keeps it private - reissue it when you are done, or stop the server.'
      })
    );
  }

  // -- wiring -------------------------------------------------------------

  $('btn-remote').addEventListener('click', async () => {
    ui.info = await window.zmaper.remoteInfo();
    if (ui.info.running && !ui.selectedAddress) {
      ui.selectedAddress = ui.info.addresses[0]?.address || null;
    }
    $('remote-modal').hidden = false;
    renderPanel();
  });

  $('remote-close').addEventListener('click', () => ($('remote-modal').hidden = true));
  $('remote-modal').addEventListener('pointerdown', (e) => {
    if (e.target === $('remote-modal')) $('remote-modal').hidden = true;
  });

  window.zmaper.on('remote:command', applyCommand);
  window.zmaper.on('remote:clients', ({ clients }) => {
    ui.info.clients = clients;
    const btn = $('btn-remote');
    btn.textContent = clients ? `Remote (${clients})` : 'Remote';
    btn.classList.toggle('tool', clients > 0);
    btn.classList.toggle('active', clients > 0);
    if (!$('remote-modal').hidden) renderPanel();
    if (clients) broadcastState();
  });

  return { broadcastState, capturePreview, isRunning: () => ui.info.running };
}
