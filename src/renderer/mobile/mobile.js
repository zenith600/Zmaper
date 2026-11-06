'use strict';

import { paramToOutput, surfaceOutline } from '../core/surfaceGeom.js';
import { pointInPolygon, distToSegment } from '../core/math.js';

const TOKEN = new URLSearchParams(location.search).get('k') || '';

const $ = (id) => document.getElementById(id);
const frame = $('frame');
const canvas = $('map');
const ctx = canvas.getContext('2d');
const previewImg = $('preview');

const HIT_PX = 26; // fingers are not mice

let state = null;
let connected = false;
let activeTab = 'surfaces';
let selectedHandle = null; // index into the selected surface's points
let nudgeStep = 1; // output pixels
let previewOn = false;
let drag = null;
let pendingState = null; // state held back while a drag is in flight

// ---------------------------------------------------------------------------
// Transport to the desktop app
// ---------------------------------------------------------------------------

function post(cmd) {
  fetch(`/cmd?k=${encodeURIComponent(TOKEN)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cmd),
    keepalive: true
  }).catch(() => {
    /* a dropped command during a drag is corrected by the next one */
  });
}

let queued = null;
let queuedRaf = 0;

/** Drag updates carry absolute positions, so only the newest one matters. */
function postThrottled(cmd) {
  queued = cmd;
  if (queuedRaf) return;
  queuedRaf = requestAnimationFrame(() => {
    queuedRaf = 0;
    const c = queued;
    queued = null;
    if (c) post(c);
  });
}

function connect() {
  if (!TOKEN) {
    $('offline').textContent = 'Missing access key. Scan the QR code in Zmaper again.';
    return;
  }

  const es = new EventSource(`/events?k=${encodeURIComponent(TOKEN)}`);

  es.onopen = () => {
    connected = true;
    $('dot').classList.add('live');
    $('offline').hidden = true;
  };

  es.onerror = () => {
    connected = false;
    $('dot').classList.remove('live');
    $('offline').hidden = false;
    $('offline').textContent = 'Reconnecting…';
  };

  es.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    if (msg.type === 'state') {
      // Holding back incoming geometry mid-drag stops the finger fighting the
      // echo coming back from the desktop.
      if (drag) pendingState = msg;
      else applyState(msg);
    } else if (msg.type === 'preview') {
      previewImg.src = msg.image;
      previewImg.classList.toggle('on', previewOn);
    }
  };
}

function applyState(msg) {
  const firstLoad = !state;
  state = msg;
  if (selectedHandle !== null) {
    const s = selectedSurface();
    const n = s ? pointsOf(s).length : 0;
    if (selectedHandle >= n) selectedHandle = null;
  }
  layout();
  draw();
  renderPanel();
  updateTitle();
  if (firstLoad) $('offline').hidden = true;
}

// ---------------------------------------------------------------------------
// Model helpers
// ---------------------------------------------------------------------------

const pointsOf = (s) => (s.type === 'quad' ? s.corners : s.points);
const selectedSurface = () => state?.surfaces.find((s) => s.id === state.selectedId) || null;

function updateTitle() {
  const s = selectedSurface();
  $('title').textContent = s ? s.name : 'Zmaper Remote';
}

// ---------------------------------------------------------------------------
// Layout and drawing
// ---------------------------------------------------------------------------

function layout() {
  if (!state) return;
  const vp = $('viewport');
  const pad = 16;
  const availW = vp.clientWidth - pad;
  const availH = vp.clientHeight - pad;
  const ar = state.output.width / state.output.height;

  let w = availW;
  let h = w / ar;
  if (h > availH) {
    h = availH;
    w = h * ar;
  }

  frame.style.width = `${Math.round(w)}px`;
  frame.style.height = `${Math.round(h)}px`;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
}

function draw() {
  if (!state) return;
  const W = canvas.width;
  const H = canvas.height;
  const scale = W / (frame.clientWidth || 1); // CSS px -> canvas px

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const sel = selectedSurface();

  for (const s of state.surfaces) {
    const isSel = s.id === state.selectedId;
    const outline = surfaceOutline(s, s.type === 'quad' ? 1 : 18);

    ctx.beginPath();
    ctx.moveTo(outline[0].x * W, outline[0].y * H);
    for (let i = 1; i < outline.length; i++) ctx.lineTo(outline[i].x * W, outline[i].y * H);
    ctx.closePath();

    if (isSel) {
      ctx.fillStyle = 'rgba(77,141,255,0.10)';
      ctx.fill();
    }
    ctx.lineWidth = (isSel ? 2.5 : 1.2) * scale;
    ctx.strokeStyle = isSel
      ? '#4d8dff'
      : s.visible
        ? 'rgba(190,200,220,0.42)'
        : 'rgba(255,84,112,0.38)';
    ctx.stroke();

    if (s.type === 'mesh' && isSel) {
      ctx.lineWidth = 1 * scale;
      ctx.strokeStyle = 'rgba(77,141,255,0.35)';
      ctx.beginPath();
      for (let i = 1; i < s.cols; i++) {
        for (let j = 0; j <= 18; j++) {
          const [x, y] = paramToOutput(s, i / s.cols, j / 18);
          j === 0 ? ctx.moveTo(x * W, y * H) : ctx.lineTo(x * W, y * H);
        }
      }
      for (let j = 1; j < s.rows; j++) {
        for (let i = 0; i <= 18; i++) {
          const [x, y] = paramToOutput(s, i / 18, j / s.rows);
          i === 0 ? ctx.moveTo(x * W, y * H) : ctx.lineTo(x * W, y * H);
        }
      }
      ctx.stroke();
    }
  }

  if (sel && !sel.locked) {
    const r = 9 * scale;
    pointsOf(sel).forEach((p, i) => {
      const on = i === selectedHandle;
      ctx.beginPath();
      ctx.arc(p.x * W, p.y * H, on ? r * 1.4 : r, 0, Math.PI * 2);
      ctx.fillStyle = on ? '#ffb020' : '#4d8dff';
      ctx.fill();
      ctx.lineWidth = 2 * scale;
      ctx.strokeStyle = on ? '#ffd27a' : '#cfe0ff';
      ctx.stroke();
    });
  }
}

// ---------------------------------------------------------------------------
// Touch interaction
// ---------------------------------------------------------------------------

/** Pointer position in normalised output space. */
function toOutput(e) {
  const r = frame.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}

function cssDist(a, b) {
  const r = frame.getBoundingClientRect();
  return Math.hypot((a.x - b.x) * r.width, (a.y - b.y) * r.height);
}

canvas.addEventListener('pointerdown', (e) => {
  if (!state) return;
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);

  const p = toOutput(e);
  const sel = selectedSurface();

  // A handle on the selected surface wins.
  if (sel && !sel.locked) {
    const pts = pointsOf(sel);
    let hit = -1;
    let best = HIT_PX;
    pts.forEach((q, i) => {
      const d = cssDist(p, q);
      if (d < best) {
        best = d;
        hit = i;
      }
    });
    if (hit >= 0) {
      selectedHandle = hit;
      post({ t: 'begin', id: sel.id });
      drag = { mode: 'handle', id: sel.id, index: hit };
      draw();
      renderPanel();
      return;
    }
  }

  const target = surfaceAt(p);
  if (!target) return;

  if (target.id !== state.selectedId) {
    state.selectedId = target.id;
    selectedHandle = null;
    post({ t: 'select', id: target.id });
    updateTitle();
    renderPanel();
  }
  if (target.locked) {
    draw();
    return;
  }

  post({ t: 'begin', id: target.id });
  drag = { mode: 'move', id: target.id, start: p, origin: pointsOf(target).map((q) => ({ ...q })) };
  draw();
});

canvas.addEventListener('pointermove', (e) => {
  if (!drag || !state) return;
  e.preventDefault();
  const p = toOutput(e);
  const s = state.surfaces.find((x) => x.id === drag.id);
  if (!s) return;

  if (drag.mode === 'handle') {
    // Optimistic local update keeps the handle glued to the finger.
    pointsOf(s)[drag.index] = { x: p.x, y: p.y };
    postThrottled({ t: 'point', id: s.id, index: drag.index, x: p.x, y: p.y });
  } else {
    const dx = p.x - drag.start.x;
    const dy = p.y - drag.start.y;
    const pts = pointsOf(s);
    for (let i = 0; i < pts.length; i++) {
      pts[i].x = drag.origin[i].x + dx;
      pts[i].y = drag.origin[i].y + dy;
    }
    postThrottled({ t: 'moveTo', id: s.id, dx, dy });
  }
  draw();
});

function endDrag(e) {
  if (!drag) return;
  drag = null;
  try {
    canvas.releasePointerCapture(e.pointerId);
  } catch {
    /* capture already released */
  }
  if (pendingState) {
    applyState(pendingState);
    pendingState = null;
  }
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

function surfaceAt(p) {
  for (let i = state.surfaces.length - 1; i >= 0; i--) {
    const s = state.surfaces[i];
    if (!s.visible) continue;
    const outline = surfaceOutline(s, s.type === 'quad' ? 1 : 14);
    if (pointInPolygon(p.x, p.y, outline)) return s;

    const r = frame.getBoundingClientRect();
    for (let k = 0; k < outline.length; k++) {
      const a = outline[k];
      const b = outline[(k + 1) % outline.length];
      const d = distToSegment(
        p.x * r.width, p.y * r.height,
        a.x * r.width, a.y * r.height,
        b.x * r.width, b.y * r.height
      );
      if (d < HIT_PX) return s;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

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

function slider(label, value, min, max, step, format, onInput) {
  const out = el('span', { class: 'val', text: format(value) });
  const input = el('input', { type: 'range', min, max, step, value });
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    out.textContent = format(v);
    onInput(v);
  });
  return el('div', { class: 'field' }, [el('label', { text: label }), input, out]);
}

const pct = (v) => `${Math.round(v * 100)}%`;

function renderPanel() {
  const panel = $('panel');
  panel.innerHTML = '';
  if (!state) return;

  if (activeTab === 'surfaces') renderSurfaces(panel);
  else if (activeTab === 'media') renderMedia(panel);
  else if (activeTab === 'tune') renderTune(panel);
  else renderNudge(panel);
}

function renderSurfaces(panel) {
  panel.appendChild(
    el('div', { class: 'btn-row' }, [
      el('button', {
        class: state.outputOpen ? 'btn live' : 'btn accent',
        text: state.outputOpen ? 'Stop Output' : 'Start Output',
        onClick: () => post({ t: 'output', on: !state.outputOpen })
      })
    ])
  );

  panel.appendChild(
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn', text: '▶ Play', onClick: () => post({ t: 'transport', action: 'play' }) }),
      el('button', { class: 'btn', text: '❙❙ Pause', onClick: () => post({ t: 'transport', action: 'pause' }) }),
      el('button', { class: 'btn', text: '↺', onClick: () => post({ t: 'transport', action: 'restart' }) })
    ])
  );

  panel.appendChild(el('div', { class: 'section-label', text: 'Surfaces' }));

  for (let i = state.surfaces.length - 1; i >= 0; i--) {
    const s = state.surfaces[i];
    const row = el('div', { class: `row${s.id === state.selectedId ? ' sel' : ''}` }, [
      el('span', { class: 'name', text: s.name }),
      el('span', { class: 'tag', text: s.type })
    ]);
    row.addEventListener('click', (e) => {
      if (e.target.classList.contains('toggle')) return;
      state.selectedId = s.id;
      selectedHandle = null;
      post({ t: 'select', id: s.id });
      updateTitle();
      draw();
      renderPanel();
    });

    row.appendChild(
      el('button', {
        class: `toggle${s.visible ? ' on' : ''}`,
        text: '◉',
        onClick: () => post({ t: 'toggle', id: s.id, key: 'visible' })
      })
    );
    row.appendChild(
      el('button', {
        class: `toggle solo${s.solo ? ' on' : ''}`,
        text: 'S',
        onClick: () => post({ t: 'toggle', id: s.id, key: 'solo' })
      })
    );
    panel.appendChild(row);
  }

  panel.appendChild(
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn', text: '+ Quad', onClick: () => post({ t: 'addSurface', kind: 'quad' }) }),
      el('button', { class: 'btn', text: '+ Mesh', onClick: () => post({ t: 'addSurface', kind: 'mesh' }) })
    ])
  );
}

function renderMedia(panel) {
  const sel = selectedSurface();
  panel.appendChild(
    el('p', { class: 'hint', text: sel ? `Tap to assign to ${sel.name}.` : 'Select a surface first.' })
  );
  for (const m of state.media) {
    const row = el('div', { class: `row${sel && sel.mediaId === m.id ? ' sel' : ''}` }, [
      el('span', { class: 'name', text: m.name }),
      el('span', { class: 'tag', text: m.kind })
    ]);
    row.addEventListener('click', () => {
      if (!sel) return toast('Select a surface first');
      post({ t: 'assign', id: sel.id, mediaId: m.id });
    });
    panel.appendChild(row);
  }
}

function renderTune(panel) {
  const s = selectedSurface();

  panel.appendChild(
    slider('Master', state.output.brightness ?? 1, 0, 1, 0.01, pct, (v) =>
      postThrottled({ t: 'set', path: 'output.brightness', value: v })
    )
  );

  if (!s) {
    panel.appendChild(el('p', { class: 'hint', text: 'Select a surface to adjust it.' }));
    return;
  }

  panel.appendChild(el('div', { class: 'section-label', text: s.name }));
  panel.appendChild(
    slider('Opacity', s.opacity ?? 1, 0, 1, 0.01, pct, (v) =>
      postThrottled({ t: 'set', id: s.id, path: 'opacity', value: v })
    )
  );
  panel.appendChild(
    slider('Brightness', s.brightness ?? 1, 0, 2, 0.01, (v) => v.toFixed(2), (v) =>
      postThrottled({ t: 'set', id: s.id, path: 'brightness', value: v })
    )
  );

  panel.appendChild(el('div', { class: 'section-label', text: 'Edge blend' }));
  for (const [key, label] of [['left', 'Left'], ['right', 'Right'], ['top', 'Top'], ['bottom', 'Bottom']]) {
    panel.appendChild(
      slider(label, s.edge?.[key] ?? 0, 0, 0.5, 0.005, pct, (v) =>
        postThrottled({ t: 'set', id: s.id, path: `edge.${key}`, value: v })
      )
    );
  }
  panel.appendChild(
    slider('Blend gamma', s.edge?.gamma ?? 2.2, 1, 4, 0.05, (v) => v.toFixed(2), (v) =>
      postThrottled({ t: 'set', id: s.id, path: 'edge.gamma', value: v })
    )
  );
}

function renderNudge(panel) {
  const s = selectedSurface();
  if (!s) {
    panel.appendChild(el('p', { class: 'hint', text: 'Select a surface to nudge it.' }));
    return;
  }

  panel.appendChild(
    el('p', {
      class: 'hint',
      text:
        selectedHandle !== null
          ? `Moving handle ${selectedHandle + 1} of ${pointsOf(s).length}. Tap a handle on the map to pick another, or clear below.`
          : `Moving all of ${s.name}. Tap a handle on the map to move just that corner.`
    })
  );

  const seg = el('div', { class: 'seg' });
  for (const step of [0.25, 1, 5]) {
    seg.appendChild(
      el('button', {
        class: step === nudgeStep ? 'active' : '',
        text: `${step} px`,
        onClick: () => {
          nudgeStep = step;
          renderPanel();
        }
      })
    );
  }
  panel.appendChild(seg);

  const nudge = (dx, dy) =>
    post({
      t: 'nudge',
      id: s.id,
      index: selectedHandle,
      dx: (dx * nudgeStep) / state.output.width,
      dy: (dy * nudgeStep) / state.output.height
    });

  const pad = el('div', { class: 'pad' });
  const cell = (label, dx, dy) =>
    label === null
      ? el('div', { class: 'spacer' })
      : el('button', { text: label, onClick: () => nudge(dx, dy) });

  pad.append(
    cell(null), cell('↑', 0, -1), cell(null),
    cell('←', -1, 0), cell('·', 0, 0), cell('→', 1, 0),
    cell(null), cell('↓', 0, 1), cell(null)
  );
  panel.appendChild(pad);

  if (selectedHandle !== null) {
    panel.appendChild(
      el('div', { class: 'btn-row' }, [
        el('button', {
          class: 'btn',
          text: 'Move whole surface',
          onClick: () => {
            selectedHandle = null;
            draw();
            renderPanel();
          }
        })
      ])
    );
  }
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

for (const b of document.querySelectorAll('.tabs button')) {
  b.addEventListener('click', () => {
    activeTab = b.dataset.tab;
    for (const o of document.querySelectorAll('.tabs button')) o.classList.toggle('active', o === b);
    renderPanel();
  });
}

$('btn-preview').addEventListener('click', () => {
  previewOn = !previewOn;
  $('btn-preview').setAttribute('aria-pressed', String(previewOn));
  previewImg.classList.toggle('on', previewOn);
  if (!previewOn) previewImg.removeAttribute('src');
  post({ t: 'preview', on: previewOn });
});

$('btn-undo').addEventListener('click', () => post({ t: 'undo' }));

let toastTimer = null;
function toast(message) {
  let n = document.querySelector('.toast');
  if (!n) {
    n = el('div', { class: 'toast' });
    document.body.appendChild(n);
  }
  n.textContent = message;
  requestAnimationFrame(() => n.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => n.classList.remove('show'), 2200);
}

window.addEventListener('resize', () => {
  layout();
  draw();
});

// Phones suspend EventSource when backgrounded; nudge a redraw on return.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    layout();
    draw();
  }
});

connect();
