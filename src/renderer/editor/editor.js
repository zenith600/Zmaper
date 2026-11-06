'use strict';

import { Renderer } from '../core/renderer.js';
import { PATTERNS, drawPattern } from '../core/media.js';
import {
  defaultProject,
  makeMedia,
  makeSurface,
  normalizeProject,
  toOutputPayload,
  surfacePoints
} from '../core/state.js';
import { clamp, distToSegment, pointInPolygon } from '../core/math.js';
import {
  paramToOutput,
  outputToParam,
  surfaceOutline,
  surfaceCenter,
  moveSurface
} from '../core/surfaceGeom.js';
import { renderInspector } from './inspector.js';
import { initRemote } from './remote.js';

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const glCanvas = $('gl');
const overlay = $('overlay');
const stage = $('stage');
const stageInner = $('stage-inner');
const octx = overlay.getContext('2d');

const HANDLE_PX = 5.5; // drawn radius in screen pixels
const HIT_PX = 11; // grab radius in screen pixels

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

const app = {
  project: defaultProject(),
  renderer: null,

  tool: 'select',
  zoom: 1,
  panX: 0,
  panY: 0,

  selectedId: null,
  selectedHandles: new Set(), // indices into surfacePoints()
  selectedMaskPoints: new Set(),

  showWire: true,
  showHandles: true,
  snap: false,

  outputOpen: false,
  displays: [],
  outputDisplayId: null,
  cameras: [],
  outputMediaErrors: {},

  undoStack: [],
  redoStack: [],
  dirty: false,

  selectedSurface() {
    return this.project.surfaces.find((s) => s.id === this.selectedId) || null;
  },
  aspect() {
    return this.project.output.width / this.project.output.height;
  }
};

try {
  app.renderer = new Renderer(glCanvas);
} catch (err) {
  document.body.innerHTML = `<div style="padding:40px;font:14px system-ui;color:#ff8b9f">${err.message}</div>`;
  throw err;
}

// ---------------------------------------------------------------------------
// Commit / sync
// ---------------------------------------------------------------------------

let syncQueued = false;

/** Call after any mutation of app.project. Pushes to GL and the output window. */
app.commit = function commit() {
  app.dirty = true;
  app.renderer.setProject(app.project);
  app.remote?.broadcastState();
  if (!syncQueued) {
    syncQueued = true;
    requestAnimationFrame(() => {
      syncQueued = false;
      if (app.outputOpen) {
        window.zmaper.send({ type: 'project', payload: toOutputPayload(app.project) });
      }
    });
  }
};

app.pushUndo = function pushUndo() {
  app.undoStack.push(snapshot());
  if (app.undoStack.length > 80) app.undoStack.shift();
  app.redoStack.length = 0;
};

function snapshot() {
  return JSON.stringify({
    output: app.project.output,
    media: app.project.media,
    surfaces: app.project.surfaces
  });
}

function restore(json) {
  const data = JSON.parse(json);
  app.project.output = data.output;
  app.project.media = data.media;
  app.project.surfaces = data.surfaces;
  if (!app.project.surfaces.some((s) => s.id === app.selectedId)) app.selectedId = null;
  app.selectedHandles.clear();
  app.selectedMaskPoints.clear();
  refreshAll();
}

function undo() {
  if (!app.undoStack.length) return toast('Nothing to undo');
  app.redoStack.push(snapshot());
  restore(app.undoStack.pop());
}
app.undo = undo;

function redo() {
  if (!app.redoStack.length) return toast('Nothing to redo');
  app.undoStack.push(snapshot());
  restore(app.redoStack.pop());
}

function refreshAll() {
  app.renderer.setProject(app.project);
  refreshLists();
  rebuildInspector();
  resizeStage();
  app.commit();
}

// ---------------------------------------------------------------------------
// View transform
// ---------------------------------------------------------------------------

/**
 * Overlay bookkeeping. The overlay canvas is deliberately larger than the
 * output frame so handles sitting exactly on the output edge are not clipped
 * in half. `margin` is in output pixels and shrinks as you zoom in, which
 * keeps the bleed a constant size on screen.
 */
const view = { previewScale: 1, marginOut: 0, marginCanvas: 0 };

function resizeStage() {
  const { width, height } = app.project.output;
  view.previewScale = 0; // force updatePreviewScale to rebuild at the new size
  stageInner.style.width = `${width}px`;
  stageInner.style.height = `${height}px`;
  applyTransform();
  $('res-label').textContent = `${width} x ${height}`;
}

/**
 * Sizes the preview framebuffer to the pixels that actually reach the screen.
 *
 * The preview canvas is displayed scaled by `zoom`, so resolution above
 * zoom x dpr is detail nobody can see. At the default fit-zoom that is about a
 * quarter of the output resolution - a large saving on an integrated GPU,
 * which is what has to push the projector at the same time.
 */
function updatePreviewScale() {
  const { width, height } = app.project.output;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const needed = clamp(app.zoom * dpr, 0.2, 1);
  const stepped = Math.min(1, Math.ceil(needed * 8) / 8); // 1/8 steps: no churn while zooming
  if (stepped === view.previewScale && glCanvas.width) return false;

  view.previewScale = stepped;
  app.renderer.resize(Math.round(width * stepped), Math.round(height * stepped));
  return true;
}

function applyTransform() {
  stageInner.style.transform = `translate(${app.panX}px, ${app.panY}px) scale(${app.zoom})`;
  $('zoom-label').textContent = `${Math.round(app.zoom * 100)}%`;
  const scaleChanged = updatePreviewScale();
  sizeOverlay(scaleChanged);
}

function sizeOverlay(force) {
  const { width, height } = app.project.output;
  const marginOut = Math.ceil(26 / Math.max(app.zoom, 0.02));
  if (!force && marginOut === view.marginOut && overlay.width) return;

  view.marginOut = marginOut;
  view.marginCanvas = Math.round(marginOut * view.previewScale);

  overlay.width = Math.round(width * view.previewScale) + view.marginCanvas * 2;
  overlay.height = Math.round(height * view.previewScale) + view.marginCanvas * 2;

  // Inline styles beat the `.stage-inner canvas { width:100% }` rule.
  overlay.style.left = `${-marginOut}px`;
  overlay.style.top = `${-marginOut}px`;
  overlay.style.width = `${width + marginOut * 2}px`;
  overlay.style.height = `${height + marginOut * 2}px`;
}

function fitView() {
  const pad = 36;
  const availW = stage.clientWidth - pad * 2;
  const availH = stage.clientHeight - pad * 2;
  const { width, height } = app.project.output;
  app.zoom = Math.min(availW / width, availH / height);
  app.panX = (stage.clientWidth - width * app.zoom) / 2;
  app.panY = (stage.clientHeight - height * app.zoom) / 2;
  applyTransform();
}

function zoomAt(clientX, clientY, factor) {
  const rect = stage.getBoundingClientRect();
  const mx = clientX - rect.left;
  const my = clientY - rect.top;
  const next = clamp(app.zoom * factor, 0.05, 12);
  // Keep the point under the cursor fixed.
  app.panX = mx - ((mx - app.panX) / app.zoom) * next;
  app.panY = my - ((my - app.panY) / app.zoom) * next;
  app.zoom = next;
  applyTransform();
}

// ---------------------------------------------------------------------------
// Coordinates
// ---------------------------------------------------------------------------

/** Mouse event -> normalised output space (0..1). */
function toOutput(e) {
  const rect = stageInner.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) / rect.width,
    y: (e.clientY - rect.top) / rect.height
  };
}

/** Screen pixels per normalised unit, per axis. */
function pxPerUnit() {
  const rect = stageInner.getBoundingClientRect();
  return { x: rect.width, y: rect.height };
}

function screenDist(a, b) {
  const s = pxPerUnit();
  return Math.hypot((a.x - b.x) * s.x, (a.y - b.y) * s.y);
}

/** Applies grid + neighbour snapping to a point being dragged. */
function applySnap(pt, excludeSurfaceId) {
  if (!app.snap) return pt;

  const s = pxPerUnit();
  const threshold = 8;
  let best = null;
  let bestD = threshold;

  for (const surf of app.project.surfaces) {
    if (surf.id === excludeSurfaceId) continue;
    for (const p of surfacePoints(surf)) {
      const d = Math.hypot((p.x - pt.x) * s.x, (p.y - pt.y) * s.y);
      if (d < bestD) {
        bestD = d;
        best = { x: p.x, y: p.y };
      }
    }
  }
  if (best) return best;

  // Fall back to a 1/64 grid of the output.
  const g = 1 / 64;
  const gx = Math.round(pt.x / g) * g;
  const gy = Math.round(pt.y / g) * g;
  if (Math.abs(gx - pt.x) * s.x < threshold && Math.abs(gy - pt.y) * s.y < threshold) {
    return { x: gx, y: gy };
  }
  return pt;
}

// ---------------------------------------------------------------------------
// Overlay drawing
// ---------------------------------------------------------------------------

let rubberBand = null;

function drawOverlay() {
  // W/H are the output frame in canvas pixels; the context origin is shifted
  // to the frame's top-left so the margin bleeds outward on all sides.
  const m = view.marginCanvas;
  const W = overlay.width - m * 2;
  const H = overlay.height - m * 2;
  octx.setTransform(1, 0, 0, 1, m, m);
  octx.clearRect(-m, -m, overlay.width, overlay.height);

  if (app.tool === 'input') {
    drawInputView(W, H);
    return;
  }

  // Line widths are divided by zoom so overlay chrome stays a constant size
  // on screen regardless of how far in the user has zoomed.
  const unit = view.previewScale / app.zoom;
  const px = (v) => v * unit;

  const selected = app.selectedSurface();

  for (const surface of app.project.surfaces) {
    const isSel = surface.id === app.selectedId;
    if (!app.showWire && !isSel) continue;
    if (!surface.visible && !isSel) continue;
    drawSurfaceWire(surface, isSel, px, W, H);
  }

  if (selected && app.tool === 'mask') drawMaskOverlay(selected, px, W, H);
  else if (selected && app.showHandles && !selected.locked) drawHandles(selected, px, W, H);

  if (rubberBand) {
    octx.save();
    octx.strokeStyle = '#4d8dff';
    octx.fillStyle = 'rgba(77,141,255,0.12)';
    octx.lineWidth = px(1);
    octx.setLineDash([px(4), px(3)]);
    const x = Math.min(rubberBand.x0, rubberBand.x1) * W;
    const y = Math.min(rubberBand.y0, rubberBand.y1) * H;
    const w = Math.abs(rubberBand.x1 - rubberBand.x0) * W;
    const h = Math.abs(rubberBand.y1 - rubberBand.y0) * H;
    octx.fillRect(x, y, w, h);
    octx.strokeRect(x, y, w, h);
    octx.restore();
  }
}

function drawSurfaceWire(surface, isSel, px, W, H) {
  const outline = surfaceOutline(surface, surface.type === 'quad' ? 1 : 20);

  octx.save();
  octx.beginPath();
  octx.moveTo(outline[0].x * W, outline[0].y * H);
  for (let i = 1; i < outline.length; i++) octx.lineTo(outline[i].x * W, outline[i].y * H);
  octx.closePath();

  octx.lineWidth = px(isSel ? 2 : 1);
  octx.strokeStyle = isSel ? '#4d8dff' : surface.visible ? 'rgba(190,200,220,0.42)' : 'rgba(255,84,112,0.38)';
  octx.stroke();

  // Interior grid for meshes makes the warp readable.
  if (surface.type === 'mesh' && (isSel || app.showWire)) {
    octx.lineWidth = px(0.75);
    octx.strokeStyle = isSel ? 'rgba(77,141,255,0.38)' : 'rgba(190,200,220,0.16)';
    octx.beginPath();
    for (let i = 1; i < surface.cols; i++) {
      const s = i / surface.cols;
      for (let j = 0; j <= 20; j++) {
        const [x, y] = paramToOutput(surface, s, j / 20);
        if (j === 0) octx.moveTo(x * W, y * H);
        else octx.lineTo(x * W, y * H);
      }
    }
    for (let j = 1; j < surface.rows; j++) {
      const t = j / surface.rows;
      for (let i = 0; i <= 20; i++) {
        const [x, y] = paramToOutput(surface, i / 20, t);
        if (i === 0) octx.moveTo(x * W, y * H);
        else octx.lineTo(x * W, y * H);
      }
    }
    octx.stroke();
  }

  if (isSel) {
    const c = surfaceCenter(surface);
    octx.fillStyle = 'rgba(207,224,255,0.92)';
    octx.font = `${px(12)}px "Segoe UI", system-ui, sans-serif`;
    octx.textAlign = 'center';
    octx.textBaseline = 'middle';
    octx.fillText(surface.name, c.x * W, c.y * H);
  }

  octx.restore();
}

function drawHandles(surface, px, W, H) {
  const pts = surfacePoints(surface);
  const r = px(HANDLE_PX);

  octx.save();
  octx.lineWidth = px(1.5);
  pts.forEach((p, i) => {
    const on = app.selectedHandles.has(i);
    const isCorner =
      surface.type === 'quad' ||
      i === 0 ||
      i === surface.cols ||
      i === pts.length - 1 ||
      i === pts.length - 1 - surface.cols;

    octx.beginPath();
    octx.arc(p.x * W, p.y * H, on ? r * 1.35 : r, 0, Math.PI * 2);
    octx.fillStyle = on ? '#ffb020' : isCorner ? '#4d8dff' : '#0f1116';
    octx.fill();
    octx.strokeStyle = on ? '#ffd27a' : '#cfe0ff';
    octx.stroke();
  });
  octx.restore();
}

function drawMaskOverlay(surface, px, W, H) {
  const pts = surface.mask.points || [];
  const mapped = pts.map((p) => {
    const [x, y] = paramToOutput(surface, p.x, p.y);
    return { x, y };
  });

  octx.save();
  if (mapped.length >= 2) {
    octx.beginPath();
    octx.moveTo(mapped[0].x * W, mapped[0].y * H);
    for (let i = 1; i < mapped.length; i++) octx.lineTo(mapped[i].x * W, mapped[i].y * H);
    if (mapped.length >= 3) octx.closePath();
    octx.fillStyle = surface.mask.invert ? 'rgba(255,84,112,0.16)' : 'rgba(61,220,151,0.14)';
    if (mapped.length >= 3) octx.fill();
    octx.lineWidth = px(1.6);
    octx.strokeStyle = surface.mask.invert ? '#ff5470' : '#3ddc97';
    octx.stroke();
  }

  const r = px(HANDLE_PX);
  mapped.forEach((p, i) => {
    const on = app.selectedMaskPoints.has(i);
    octx.beginPath();
    octx.arc(p.x * W, p.y * H, on ? r * 1.35 : r, 0, Math.PI * 2);
    octx.fillStyle = on ? '#ffb020' : '#3ddc97';
    octx.fill();
    octx.lineWidth = px(1.2);
    octx.strokeStyle = '#0c1a14';
    octx.stroke();
  });
  octx.restore();
}

/** Source view: the media at full frame with a draggable crop rectangle. */
function drawInputView(W, H) {
  const surface = app.selectedSurface();
  octx.fillStyle = '#0a0b0e';
  octx.fillRect(0, 0, W, H);

  if (!surface) {
    drawCenteredText('Select a surface to edit its source crop', W, H);
    return;
  }

  const entry = surface.mediaId ? app.renderer.media.get(surface.mediaId) : null;
  const box = inputViewBox(W, H, entry);

  if (entry && entry.ready && entry.element) {
    try {
      octx.drawImage(entry.element, box.x, box.y, box.w, box.h);
    } catch {
      /* a video frame can briefly be undecodable; the next frame will land */
    }
  } else {
    octx.fillStyle = '#15171d';
    octx.fillRect(box.x, box.y, box.w, box.h);
    drawCenteredText(entry?.error || 'No media assigned to this surface', W, H);
  }

  const unit = view.previewScale / app.zoom;
  const px = (v) => v * unit;
  const inp = surface.input;
  const rx = box.x + inp.x * box.w;
  const ry = box.y + inp.y * box.h;
  const rw = inp.w * box.w;
  const rh = inp.h * box.h;

  // Darken everything outside the crop.
  octx.save();
  octx.fillStyle = 'rgba(6,7,10,0.62)';
  octx.beginPath();
  octx.rect(box.x, box.y, box.w, box.h);
  octx.rect(rx, ry, rw, rh);
  octx.fill('evenodd');

  octx.strokeStyle = '#4d8dff';
  octx.lineWidth = px(1.8);
  octx.strokeRect(rx, ry, rw, rh);

  // Thirds guides inside the crop.
  octx.strokeStyle = 'rgba(77,141,255,0.3)';
  octx.lineWidth = px(0.8);
  octx.beginPath();
  for (let i = 1; i < 3; i++) {
    octx.moveTo(rx + (rw * i) / 3, ry);
    octx.lineTo(rx + (rw * i) / 3, ry + rh);
    octx.moveTo(rx, ry + (rh * i) / 3);
    octx.lineTo(rx + rw, ry + (rh * i) / 3);
  }
  octx.stroke();

  const r = px(HANDLE_PX + 0.5);
  for (const [cx, cy] of [
    [rx, ry],
    [rx + rw, ry],
    [rx + rw, ry + rh],
    [rx, ry + rh]
  ]) {
    octx.beginPath();
    octx.arc(cx, cy, r, 0, Math.PI * 2);
    octx.fillStyle = '#4d8dff';
    octx.fill();
    octx.lineWidth = px(1.2);
    octx.strokeStyle = '#cfe0ff';
    octx.stroke();
  }
  octx.restore();
}

/** The letterboxed rectangle the source media occupies in the source view. */
function inputViewBox(W, H, entry) {
  const pad = Math.min(W, H) * 0.06;
  const availW = W - pad * 2;
  const availH = H - pad * 2;
  const ar = entry && entry.width && entry.height ? entry.width / entry.height : W / H;
  let w = availW;
  let h = w / ar;
  if (h > availH) {
    h = availH;
    w = h * ar;
  }
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

function drawCenteredText(text, W, H) {
  octx.save();
  octx.fillStyle = '#6b7284';
  octx.font = `${Math.round(W / 55)}px "Segoe UI", system-ui, sans-serif`;
  octx.textAlign = 'center';
  octx.textBaseline = 'middle';
  octx.fillText(text, W / 2, H / 2);
  octx.restore();
}

// ---------------------------------------------------------------------------
// Pointer interaction
// ---------------------------------------------------------------------------

let drag = null;
let spaceDown = false;

stage.addEventListener('contextmenu', (e) => e.preventDefault());

stage.addEventListener('pointerdown', (e) => {
  if (e.button === 1 || spaceDown || (e.button === 0 && e.altKey && !app.selectedSurface())) {
    drag = { mode: 'pan', startX: e.clientX, startY: e.clientY, panX: app.panX, panY: app.panY };
    stage.setPointerCapture(e.pointerId);
    return;
  }

  if (app.tool === 'input') {
    beginInputDrag(e);
    return;
  }
  if (app.tool === 'mask') {
    beginMaskDrag(e);
    return;
  }
  beginSelectDrag(e);
});

stage.addEventListener('pointermove', (e) => {
  if (!drag) {
    updateCursor(e);
    return;
  }

  switch (drag.mode) {
    case 'pan': {
      app.panX = drag.panX + (e.clientX - drag.startX);
      app.panY = drag.panY + (e.clientY - drag.startY);
      applyTransform();
      break;
    }
    case 'handles': {
      const p = toOutput(e);
      let dx = p.x - drag.startPos.x;
      let dy = p.y - drag.startPos.y;
      if (e.shiftKey) {
        // Shift constrains to the dominant axis.
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      const pts = surfacePoints(drag.surface);
      for (const [i, orig] of drag.origin) {
        let nx = orig.x + dx;
        let ny = orig.y + dy;
        if (drag.indices.length === 1) {
          const snapped = applySnap({ x: nx, y: ny }, drag.surface.id);
          nx = snapped.x;
          ny = snapped.y;
        }
        pts[i].x = nx;
        pts[i].y = ny;
      }
      app.commit();
      break;
    }
    case 'move': {
      const p = toOutput(e);
      let dx = p.x - drag.startPos.x;
      let dy = p.y - drag.startPos.y;
      if (e.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      const pts = surfacePoints(drag.surface);
      for (let i = 0; i < pts.length; i++) {
        pts[i].x = drag.originAll[i].x + dx;
        pts[i].y = drag.originAll[i].y + dy;
      }
      app.commit();
      break;
    }
    case 'maskPoints': {
      const p = toOutput(e);
      const [s, t] = outputToParam(drag.surface, p.x, p.y);
      const ds = s - drag.startParam[0];
      const dt = t - drag.startParam[1];
      for (const [i, orig] of drag.origin) {
        drag.surface.mask.points[i].x = orig.x + ds;
        drag.surface.mask.points[i].y = orig.y + dt;
      }
      app.commit();
      break;
    }
    case 'rubber': {
      const p = toOutput(e);
      rubberBand.x1 = p.x;
      rubberBand.y1 = p.y;
      break;
    }
    case 'cropMove':
    case 'cropCorner': {
      moveCrop(e);
      break;
    }
  }
});

stage.addEventListener('pointerup', (e) => {
  if (drag && drag.mode === 'rubber') {
    commitRubberBand(e.shiftKey);
    rubberBand = null;
    rebuildInspector();
  }
  if (drag) {
    try {
      stage.releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be gone */
    }
  }
  drag = null;
});

stage.addEventListener('pointercancel', () => {
  drag = null;
  rubberBand = null;
});

stage.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
  },
  { passive: false }
);

function beginSelectDrag(e) {
  const p = toOutput(e);
  const selected = app.selectedSurface();

  // 1. A handle on the current selection wins over everything else.
  if (selected && !selected.locked && app.showHandles) {
    const pts = surfacePoints(selected);
    let hit = -1;
    let bestD = HIT_PX;
    pts.forEach((q, i) => {
      const d = screenDist(p, q);
      if (d < bestD) {
        bestD = d;
        hit = i;
      }
    });

    if (hit >= 0) {
      if (e.shiftKey) {
        if (app.selectedHandles.has(hit)) app.selectedHandles.delete(hit);
        else app.selectedHandles.add(hit);
      } else if (!app.selectedHandles.has(hit)) {
        app.selectedHandles.clear();
        app.selectedHandles.add(hit);
      }

      if (app.selectedHandles.size) {
        app.pushUndo();
        const indices = [...app.selectedHandles];
        drag = {
          mode: 'handles',
          surface: selected,
          indices,
          origin: indices.map((i) => [i, { ...pts[i] }]),
          startPos: p
        };
        stage.setPointerCapture(e.pointerId);
      }
      return;
    }
  }

  // 2. Shift-drag on empty space rubber-bands handles of the selection.
  if (e.shiftKey && selected) {
    rubberBand = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    drag = { mode: 'rubber', surface: selected };
    stage.setPointerCapture(e.pointerId);
    return;
  }

  // 3. Topmost surface under the cursor.
  const hitSurface = surfaceAt(p);
  if (hitSurface) {
    if (hitSurface.id !== app.selectedId) {
      app.selectedId = hitSurface.id;
      app.selectedHandles.clear();
      app.selectedMaskPoints.clear();
      refreshLists();
      rebuildInspector();
    }
    if (!hitSurface.locked) {
      app.pushUndo();
      drag = {
        mode: 'move',
        surface: hitSurface,
        originAll: surfacePoints(hitSurface).map((q) => ({ ...q })),
        startPos: p
      };
      stage.setPointerCapture(e.pointerId);
    }
    return;
  }

  // 4. Empty space: clear selection.
  if (app.selectedId !== null) {
    app.selectedId = null;
    app.selectedHandles.clear();
    app.selectedMaskPoints.clear();
    refreshLists();
    rebuildInspector();
  }
}

function surfaceAt(p) {
  for (let i = app.project.surfaces.length - 1; i >= 0; i--) {
    const s = app.project.surfaces[i];
    if (!s.visible) continue;
    const outline = surfaceOutline(s, s.type === 'quad' ? 1 : 16);
    if (pointInPolygon(p.x, p.y, outline)) return s;

    // Allow grabbing a thin or collapsed surface by its edge.
    const scale = pxPerUnit();
    for (let k = 0; k < outline.length; k++) {
      const a = outline[k];
      const b = outline[(k + 1) % outline.length];
      const d = distToSegment(p.x * scale.x, p.y * scale.y, a.x * scale.x, a.y * scale.y, b.x * scale.x, b.y * scale.y);
      if (d < HIT_PX) return s;
    }
  }
  return null;
}

function commitRubberBand(additive) {
  const s = drag.surface;
  if (!s) return;
  const x0 = Math.min(rubberBand.x0, rubberBand.x1);
  const x1 = Math.max(rubberBand.x0, rubberBand.x1);
  const y0 = Math.min(rubberBand.y0, rubberBand.y1);
  const y1 = Math.max(rubberBand.y0, rubberBand.y1);
  if (!additive) app.selectedHandles.clear();
  surfacePoints(s).forEach((q, i) => {
    if (q.x >= x0 && q.x <= x1 && q.y >= y0 && q.y <= y1) app.selectedHandles.add(i);
  });
}

// -- Mask tool ---------------------------------------------------------------

function beginMaskDrag(e) {
  const surface = app.selectedSurface();
  if (!surface) return;
  const p = toOutput(e);
  const mask = surface.mask;
  mask.points = mask.points || [];

  const mapped = mask.points.map((q) => {
    const [x, y] = paramToOutput(surface, q.x, q.y);
    return { x, y };
  });

  let hit = -1;
  let bestD = HIT_PX;
  mapped.forEach((q, i) => {
    const d = screenDist(p, q);
    if (d < bestD) {
      bestD = d;
      hit = i;
    }
  });

  // Right-click removes a point.
  if (e.button === 2) {
    if (hit >= 0) {
      app.pushUndo();
      mask.points.splice(hit, 1);
      app.selectedMaskPoints.clear();
      rebuildInspector();
      app.commit();
    }
    return;
  }
  if (e.button !== 0) return;

  if (hit >= 0) {
    if (e.shiftKey) {
      if (app.selectedMaskPoints.has(hit)) app.selectedMaskPoints.delete(hit);
      else app.selectedMaskPoints.add(hit);
    } else if (!app.selectedMaskPoints.has(hit)) {
      app.selectedMaskPoints.clear();
      app.selectedMaskPoints.add(hit);
    }
    app.pushUndo();
    const indices = [...app.selectedMaskPoints];
    drag = {
      mode: 'maskPoints',
      surface,
      origin: indices.map((i) => [i, { ...mask.points[i] }]),
      startParam: outputToParam(surface, p.x, p.y)
    };
    stage.setPointerCapture(e.pointerId);
    return;
  }

  // Click on an edge inserts a point there; otherwise append to the end.
  const [s, t] = outputToParam(surface, p.x, p.y);
  app.pushUndo();
  const insertAt = nearestEdgeIndex(mapped, p);
  if (insertAt >= 0) mask.points.splice(insertAt, 0, { x: s, y: t });
  else mask.points.push({ x: s, y: t });
  mask.enabled = true;
  app.selectedMaskPoints.clear();
  rebuildInspector();
  app.commit();
}

/** Index to insert at, when the click lands on an existing polygon edge. */
function nearestEdgeIndex(mapped, p) {
  if (mapped.length < 3) return -1;
  const scale = pxPerUnit();
  let best = -1;
  let bestD = HIT_PX * 1.6;
  for (let i = 0; i < mapped.length; i++) {
    const a = mapped[i];
    const b = mapped[(i + 1) % mapped.length];
    const d = distToSegment(p.x * scale.x, p.y * scale.y, a.x * scale.x, a.y * scale.y, b.x * scale.x, b.y * scale.y);
    if (d < bestD) {
      bestD = d;
      best = i + 1;
    }
  }
  return best;
}

// -- Source (crop) tool ------------------------------------------------------

function beginInputDrag(e) {
  const surface = app.selectedSurface();
  if (!surface || e.button !== 0) return;

  const W = overlay.width - view.marginCanvas * 2;
  const H = overlay.height - view.marginCanvas * 2;
  const entry = surface.mediaId ? app.renderer.media.get(surface.mediaId) : null;
  const box = inputViewBox(W, H, entry);

  // Pointer position in the same canvas space drawInputView draws in.
  const rect = stageInner.getBoundingClientRect();
  const ox = ((e.clientX - rect.left) / rect.width) * W;
  const oy = ((e.clientY - rect.top) / rect.height) * H;

  const inp = surface.input;
  const rx = box.x + inp.x * box.w;
  const ry = box.y + inp.y * box.h;
  const rw = inp.w * box.w;
  const rh = inp.h * box.h;

  const corners = [
    [rx, ry],
    [rx + rw, ry],
    [rx + rw, ry + rh],
    [rx, ry + rh]
  ];
  const grabPx = (HIT_PX * view.previewScale) / app.zoom;

  let corner = -1;
  corners.forEach(([cx, cy], i) => {
    if (Math.hypot(ox - cx, oy - cy) < grabPx) corner = i;
  });

  app.pushUndo();
  if (corner >= 0) {
    drag = { mode: 'cropCorner', surface, box, corner, start: { ...inp } };
  } else {
    drag = { mode: 'cropMove', surface, box, startOx: ox, startOy: oy, start: { ...inp } };
  }
  stage.setPointerCapture(e.pointerId);
}

function moveCrop(e) {
  const W = overlay.width - view.marginCanvas * 2;
  const H = overlay.height - view.marginCanvas * 2;
  const rect = stageInner.getBoundingClientRect();
  const ox = ((e.clientX - rect.left) / rect.width) * W;
  const oy = ((e.clientY - rect.top) / rect.height) * H;

  const { box, surface, start } = drag;
  const inp = surface.input;
  const u = (ox - box.x) / box.w;
  const v = (oy - box.y) / box.h;

  if (drag.mode === 'cropMove') {
    const du = (ox - drag.startOx) / box.w;
    const dv = (oy - drag.startOy) / box.h;
    inp.x = start.x + du;
    inp.y = start.y + dv;
  } else {
    const x0 = start.x;
    const y0 = start.y;
    const x1 = start.x + start.w;
    const y1 = start.y + start.h;
    let nx0 = x0;
    let ny0 = y0;
    let nx1 = x1;
    let ny1 = y1;
    if (drag.corner === 0) {
      nx0 = u;
      ny0 = v;
    } else if (drag.corner === 1) {
      nx1 = u;
      ny0 = v;
    } else if (drag.corner === 2) {
      nx1 = u;
      ny1 = v;
    } else {
      nx0 = u;
      ny1 = v;
    }
    inp.x = Math.min(nx0, nx1);
    inp.y = Math.min(ny0, ny1);
    inp.w = Math.max(0.01, Math.abs(nx1 - nx0));
    inp.h = Math.max(0.01, Math.abs(ny1 - ny0));
  }
  app.commit();
}

function updateCursor(e) {
  if (spaceDown) {
    stage.style.cursor = 'grab';
    return;
  }
  if (app.tool === 'mask') {
    stage.style.cursor = 'crosshair';
    return;
  }
  if (app.tool === 'input') {
    stage.style.cursor = 'crosshair';
    return;
  }

  const p = toOutput(e);
  const selected = app.selectedSurface();
  if (selected && !selected.locked) {
    for (const q of surfacePoints(selected)) {
      if (screenDist(p, q) < HIT_PX) {
        stage.style.cursor = 'pointer';
        return;
      }
    }
  }
  stage.style.cursor = surfaceAt(p) ? 'move' : 'default';
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

function refreshLists() {
  renderSurfaceList();
  renderMediaList();
}
app.refreshLists = refreshLists;

function renderSurfaceList() {
  const list = $('surface-list');
  list.innerHTML = '';
  $('surface-count').textContent = String(app.project.surfaces.length);

  if (!app.project.surfaces.length) {
    list.appendChild(
      Object.assign(document.createElement('p'), {
        className: 'empty',
        textContent: 'No surfaces yet. Add a Quad to get started.'
      })
    );
    return;
  }

  // Topmost first, matching draw order (last drawn appears at the top).
  for (let i = app.project.surfaces.length - 1; i >= 0; i--) {
    const s = app.project.surfaces[i];
    const row = document.createElement('div');
    row.className = 'row' + (s.id === app.selectedId ? ' selected' : '');
    row.dataset.surfaceId = s.id;

    row.appendChild(flagButton('◉', s.visible, 'vis', (on) => {
      s.visible = on;
      app.commit();
      renderSurfaceList();
    }));
    row.appendChild(flagButton('S', s.solo, 'solo', (on) => {
      s.solo = on;
      app.commit();
      renderSurfaceList();
    }));

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = s.name;
    row.appendChild(name);

    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = s.type;
    row.appendChild(tag);

    row.appendChild(flagButton('\u{1F512}', s.locked, 'lock', (on) => {
      s.locked = on;
      app.commit();
      renderSurfaceList();
    }));

    row.addEventListener('click', (e) => {
      if (e.target.classList.contains('flag')) return;
      app.selectedId = s.id;
      app.selectedHandles.clear();
      app.selectedMaskPoints.clear();
      renderSurfaceList();
      rebuildInspector();
    });

    list.appendChild(row);
  }
}

function flagButton(glyph, on, kind, onToggle) {
  const b = document.createElement('span');
  b.className = `flag ${kind}${on ? ' on' : ''}`;
  b.textContent = glyph;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onToggle(!on);
  });
  return b;
}

const thumbCache = new Map();

function renderMediaList() {
  const list = $('media-list');
  list.innerHTML = '';
  const selected = app.selectedSurface();

  if (!app.project.media.length) {
    list.appendChild(
      Object.assign(document.createElement('p'), {
        className: 'empty',
        textContent: 'Drag video or image files here, or use + File.'
      })
    );
    return;
  }

  for (const m of app.project.media) {
    const row = document.createElement('div');
    row.className = 'row' + (selected && selected.mediaId === m.id ? ' selected' : '');
    row.dataset.mediaId = m.id;

    const sw = document.createElement('span');
    sw.className = 'swatch';
    if (m.kind === 'color') {
      const [r, g, b] = m.color;
      sw.style.background = `rgb(${r * 255},${g * 255},${b * 255})`;
    } else if (m.kind === 'image' && m.url) {
      sw.style.backgroundImage = `url("${m.url}")`;
    } else if (m.kind === 'pattern') {
      if (!thumbCache.has(m.pattern)) thumbCache.set(m.pattern, drawPattern(m.pattern, 96, 72).toDataURL());
      sw.style.backgroundImage = `url("${thumbCache.get(m.pattern)}")`;
    } else {
      sw.style.background = '#232733';
    }
    row.appendChild(sw);

    // A webcam row carries its device picker inline. Burying it in the
    // inspector hides it until the camera happens to be the selected
    // surface's source, which is not where anyone looks for it.
    if (m.kind === 'webcam') {
      row.appendChild(cameraSelect(m));
    } else {
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = m.name;
      name.title = m.path || m.kind;
      row.appendChild(name);
    }

    const entry = app.renderer.media.get(m.id);
    const problem = (entry && entry.error) || app.outputMediaErrors?.[m.id];
    if (problem) {
      row.classList.add('bad');
      row.title = app.outputMediaErrors?.[m.id] ? `Output: ${problem}` : problem;
    }

    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = m.kind === 'webcam' ? 'cam' : m.kind.slice(0, 3);
    row.appendChild(tag);

    const del = document.createElement('span');
    del.className = 'flag';
    del.textContent = '×';
    del.title = 'Remove media';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      app.pushUndo();
      app.project.media = app.project.media.filter((x) => x.id !== m.id);
      for (const s of app.project.surfaces) if (s.mediaId === m.id) s.mediaId = null;
      refreshLists();
      rebuildInspector();
      app.commit();
    });
    row.appendChild(del);

    row.addEventListener('click', (e) => {
      if (e.target === del) return;
      const s = app.selectedSurface();
      if (!s) return toast('Select a surface first');
      app.pushUndo();
      s.mediaId = m.id;
      refreshLists();
      rebuildInspector();
      app.commit();
    });

    list.appendChild(row);
  }
}

/** Inline camera chooser used by webcam rows in the media list. */
function cameraSelect(media) {
  const sel = document.createElement('select');
  sel.className = 'row-select';
  sel.title = 'Choose which camera this source captures';

  const cams = (app.cameras || []).filter((c) => c.deviceId);
  if (!cams.length) {
    const only = document.createElement('option');
    only.textContent = media.name || 'Webcam';
    sel.appendChild(only);
    sel.disabled = true;
    sel.title = 'No cameras detected - plug one in, then press + Cam again';
  } else {
    const def = document.createElement('option');
    def.value = '';
    def.textContent = 'System default';
    sel.appendChild(def);
    for (const c of cams) {
      const o = document.createElement('option');
      o.value = c.deviceId;
      o.textContent = c.label;
      if (c.deviceId === media.deviceId) o.selected = true;
      sel.appendChild(o);
    }
  }

  // The row itself assigns media to the selected surface; the picker must not
  // trigger that while the user is choosing a device.
  for (const type of ['click', 'pointerdown', 'mousedown']) {
    sel.addEventListener(type, (e) => e.stopPropagation());
  }
  sel.addEventListener('change', (e) => {
    e.stopPropagation();
    app.pushUndo();
    media.deviceId = sel.value || null;
    const cam = cams.find((c) => c.deviceId === sel.value);
    media.name = cam ? cam.label : 'Webcam';
    refreshLists();
    rebuildInspector();
    app.commit();
    toast(`Camera: ${media.name}`);
  });

  return sel;
}

function buildPatternButtons() {
  const grid = $('pattern-grid');
  grid.innerHTML = '';
  for (const p of PATTERNS) {
    const b = document.createElement('button');
    b.textContent = p;
    b.addEventListener('click', () => {
      app.pushUndo();
      const media = makeMedia({ kind: 'pattern', pattern: p, name: p[0].toUpperCase() + p.slice(1) });
      app.project.media.push(media);
      const s = app.selectedSurface();
      if (s) s.mediaId = media.id;
      refreshLists();
      rebuildInspector();
      app.commit();
    });
    grid.appendChild(b);
  }
}

// ---------------------------------------------------------------------------
// Inspector hooks
// ---------------------------------------------------------------------------

function rebuildInspector() {
  renderInspector($('inspector-body'), app);
}
app.rebuildInspector = rebuildInspector;

app.duplicateSurface = function duplicateSurface(id) {
  const src = app.project.surfaces.find((s) => s.id === id);
  if (!src) return;
  app.pushUndo();
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  copy.name = `${src.name} copy`;
  moveSurface(copy, 0.03, 0.03);
  app.project.surfaces.push(copy);
  app.selectedId = copy.id;
  app.selectedHandles.clear();
  refreshLists();
  rebuildInspector();
  app.commit();
};

app.deleteSurface = function deleteSurface(id) {
  app.pushUndo();
  app.project.surfaces = app.project.surfaces.filter((s) => s.id !== id);
  if (app.selectedId === id) app.selectedId = null;
  app.selectedHandles.clear();
  app.selectedMaskPoints.clear();
  refreshLists();
  rebuildInspector();
  app.commit();
};

app.setOutputSize = function setOutputSize(w, h) {
  app.project.output.width = clamp(Math.round(w), 320, 16384);
  app.project.output.height = clamp(Math.round(h), 240, 16384);
  resizeStage();
  fitView();
  app.commit();
};

app.matchDisplayResolution = function matchDisplayResolution() {
  const d = app.displays.find((x) => x.id === Number($('display-select').value));
  if (!d) return toast('No display selected');
  app.setOutputSize(d.width, d.height);
  toast(`Output set to ${d.width} x ${d.height}`);
};

app.fillOutput = function fillOutput(s) {
  if (s.type === 'quad') {
    s.corners = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 }
    ];
  } else {
    const next = [];
    for (let j = 0; j <= s.rows; j++) {
      for (let i = 0; i <= s.cols; i++) next.push({ x: i / s.cols, y: j / s.rows });
    }
    s.points = next;
  }
};

/** Centre-crops the source so it fills the surface without distortion. */
app.fitSourceAspect = function fitSourceAspect(s) {
  const entry = s.mediaId ? app.renderer.media.get(s.mediaId) : null;
  if (!entry || !entry.width || !entry.height) return toast('Media has no size yet');

  const pts = surfacePoints(s);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const surfAR =
    ((maxX - minX) * app.project.output.width) / Math.max(1e-6, (maxY - minY) * app.project.output.height);
  const mediaAR = entry.width / entry.height;

  if (mediaAR > surfAR) {
    const w = surfAR / mediaAR;
    Object.assign(s.input, { x: (1 - w) / 2, y: 0, w, h: 1 });
  } else {
    const h = mediaAR / surfAR;
    Object.assign(s.input, { x: 0, y: (1 - h) / 2, w: 1, h });
  }
};

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

function addSurface(type) {
  app.pushUndo();
  const s = makeSurface(type, app.project.surfaces.length, {
    mediaId: app.project.media[0]?.id || null
  });
  app.project.surfaces.push(s);
  app.selectedId = s.id;
  app.selectedHandles.clear();
  refreshLists();
  rebuildInspector();
  app.commit();
}

function setTool(tool) {
  app.tool = tool;
  for (const b of document.querySelectorAll('.btn.tool[data-tool]')) {
    b.classList.toggle('active', b.dataset.tool === tool);
  }
  glCanvas.style.opacity = tool === 'input' ? '0' : '1';
  $('view-label').textContent =
    tool === 'input' ? 'Source view' : tool === 'mask' ? 'Mask editing' : 'Output view';
  $('status').textContent =
    tool === 'input'
      ? 'Drag the crop rectangle or its corners · V returns to warping'
      : tool === 'mask'
        ? 'Click to add mask points · drag to move · right-click a point to delete · V returns to warping'
        : 'Drag inside a surface to move it · drag handles to warp · Shift+drag to box-select handles · Scroll to zoom · Space+drag to pan';
}

$('btn-add-quad').addEventListener('click', () => addSurface('quad'));
$('btn-add-mesh').addEventListener('click', () => addSurface('mesh'));
for (const b of document.querySelectorAll('.btn.tool[data-tool]')) {
  b.addEventListener('click', () => setTool(b.dataset.tool));
}

/**
 * Adds media descriptors to the library and optionally assigns one to a
 * surface. `pick` chooses which of a multi-file import gets assigned: the file
 * dialog assigns the last, a drop assigns the first (the one you aimed with).
 */
function importMediaFiles(files, { assignTo = null, pick = 'last', quiet = false } = {}) {
  if (!files || !files.length) return [];

  app.pushUndo();
  const added = files.map((f) => {
    const media = makeMedia({ kind: f.kind, name: f.name, path: f.path, url: f.url });
    app.project.media.push(media);
    return media;
  });

  const target = assignTo || app.selectedSurface();
  if (target) target.mediaId = (pick === 'first' ? added[0] : added[added.length - 1]).id;

  refreshLists();
  rebuildInspector();
  app.commit();

  if (!quiet) {
    const what = added.length === 1 ? added[0].name : `${added.length} files`;
    toast(target ? `${what} → ${target.name}` : `Added ${what}`);
  }
  return added;
}

/**
 * Swaps the source behind an existing media item, keeping its id so every
 * surface already using it updates in place - in the editor and the output.
 */
function replaceMediaSource(mediaId, file) {
  const m = app.project.media.find((x) => x.id === mediaId);
  if (!m) return;
  app.pushUndo();
  Object.assign(m, {
    kind: file.kind,
    name: file.name,
    path: file.path,
    url: file.url,
    deviceId: null
  });
  refreshLists();
  rebuildInspector();
  app.commit();

  const users = app.project.surfaces.filter((s) => s.mediaId === mediaId).length;
  toast(users > 1 ? `Replaced with ${file.name} on ${users} surfaces` : `Replaced with ${file.name}`);
}

async function addMediaViaDialog() {
  const files = await window.zmaper.pickMedia();
  importMediaFiles(files);
}

$('btn-add-media').addEventListener('click', addMediaViaDialog);
$('btn-add-file').addEventListener('click', addMediaViaDialog);

// ---------------------------------------------------------------------------
// Drag and drop
// ---------------------------------------------------------------------------

/** Resolves a drop into media descriptors via the main process. */
async function filesFromDrop(e) {
  const dropped = [...(e.dataTransfer?.files || [])];
  const paths = dropped.map((f) => window.zmaper.getPathForFile(f)).filter(Boolean);
  if (!paths.length) return [];
  return window.zmaper.resolveMedia(paths);
}

function isFileDrag(e) {
  return [...(e.dataTransfer?.types || [])].includes('Files');
}

// Without preventDefault, dropping a file anywhere makes Electron navigate to
// it. The drop zones below stopPropagation, so this only catches drops on the
// chrome - toolbar, inspector, empty panel space - which just add to the library.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  if (!isFileDrag(e)) return;
  const files = await filesFromDrop(e);
  if (files.length) importMediaFiles(files, { pick: 'first' });
});

function wireDropZone(node, { onDrop, rowSelector = null }) {
  let hoverRow = null;

  const clearRow = () => {
    hoverRow?.classList.remove('drop-target');
    hoverRow = null;
  };

  node.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    node.classList.add('drop-active');

    if (rowSelector) {
      const row = e.target instanceof Element ? e.target.closest(rowSelector) : null;
      if (row !== hoverRow) {
        clearRow();
        hoverRow = row;
        row?.classList.add('drop-target');
      }
    }
  });

  node.addEventListener('dragleave', (e) => {
    if (node.contains(e.relatedTarget)) return;
    node.classList.remove('drop-active');
    clearRow();
  });

  node.addEventListener('drop', async (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const row = hoverRow;
    node.classList.remove('drop-active');
    clearRow();

    const files = await filesFromDrop(e);
    if (!files.length) {
      toast('No supported video or image files in that drop', true);
      return;
    }
    onDrop(files, row, e);
  });
}

// Canvas: drop onto a surface to replace what it is showing.
wireDropZone(stage, {
  onDrop: (files, _row, e) => {
    const target = surfaceAt(toOutput(e));
    if (target) {
      app.selectedId = target.id;
      app.selectedHandles.clear();
      app.selectedMaskPoints.clear();
    }
    importMediaFiles(files, { assignTo: target, pick: 'first' });
  }
});

// Media list: drop onto a row to replace that source, or anywhere else to add.
wireDropZone($('media-list'), {
  rowSelector: '.row',
  onDrop: (files, row) => {
    if (row?.dataset.mediaId) replaceMediaSource(row.dataset.mediaId, files[0]);
    else importMediaFiles(files, { pick: 'first' });
  }
});

// Surface list: drop onto a surface row to assign straight to it.
wireDropZone($('surface-list'), {
  rowSelector: '.row',
  onDrop: (files, row) => {
    const target = row?.dataset.surfaceId
      ? app.project.surfaces.find((s) => s.id === row.dataset.surfaceId)
      : null;
    importMediaFiles(files, { assignTo: target, pick: 'first' });
  }
});

$('btn-add-webcam').addEventListener('click', async () => {
  await refreshCameras();
  app.pushUndo();

  // Before permission is granted the browser reports devices with blank ids;
  // null means "whatever the system default is", which is the right fallback.
  const first = app.cameras[0];
  const media = makeMedia({
    kind: 'webcam',
    name: first?.label || 'Webcam',
    deviceId: first?.deviceId || null
  });
  app.project.media.push(media);
  const s = app.selectedSurface();
  if (s) s.mediaId = media.id;
  refreshLists();
  rebuildInspector();
  app.commit();

  if (app.cameras.length > 1) toast(`${app.cameras.length} cameras found - pick one under Source`);

  // Once the stream is live, permission exists and real names are available.
  setTimeout(async () => {
    await refreshCameras();
    const cam = app.cameras.find((c) => c.deviceId === media.deviceId) || app.cameras[0];
    if (cam && media.name === 'Webcam' && cam.label) {
      media.name = cam.label;
      if (!media.deviceId) media.deviceId = cam.deviceId || null;
    }
    refreshLists();
    rebuildInspector();
  }, 1500);
});

$('chk-wire').addEventListener('change', (e) => (app.showWire = e.target.checked));
$('chk-handles').addEventListener('change', (e) => (app.showHandles = e.target.checked));
$('chk-snap').addEventListener('change', (e) => (app.snap = e.target.checked));
$('btn-fit').addEventListener('click', fitView);

// -- Transport ---------------------------------------------------------------

app.transport = function transport(action) {
  if (action === 'play') {
    app.renderer.media.play(null);
    window.zmaper.send({ type: 'transport', action: 'play' });
  } else if (action === 'pause') {
    app.renderer.media.pause(null);
    window.zmaper.send({ type: 'transport', action: 'pause' });
  } else if (action === 'restart') {
    app.renderer.media.seek(null, 0);
    app.renderer.media.play(null);
    window.zmaper.send({ type: 'transport', action: 'seek', time: 0 });
    window.zmaper.send({ type: 'transport', action: 'play' });
  }
};

$('btn-play').addEventListener('click', () => app.transport('play'));
$('btn-pause').addEventListener('click', () => app.transport('pause'));
$('btn-restart').addEventListener('click', () => app.transport('restart'));

// -- Output ------------------------------------------------------------------

async function refreshDisplays() {
  app.displays = await window.zmaper.listDisplays();
  const sel = $('display-select');
  const previous = sel.value;
  sel.innerHTML = '';
  for (const d of app.displays) {
    const opt = document.createElement('option');
    opt.value = String(d.id);
    opt.textContent = d.label;
    sel.appendChild(opt);
  }
  // Default to a secondary display - that is where a projector normally sits.
  const secondary = app.displays.find((d) => !d.primary);
  sel.value = previous && app.displays.some((d) => String(d.id) === previous)
    ? previous
    : String((secondary || app.displays[0]).id);
  app.outputDisplayId = Number(sel.value);
}

/**
 * Enumerates video inputs. Browsers withhold device labels (and ids) until
 * camera permission has been granted, so this is re-run once a stream is live
 * and whenever the user plugs something in.
 */
async function refreshCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    app.cameras = devices
      .filter((d) => d.kind === 'videoinput')
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
  } catch {
    app.cameras = [];
  }
  return app.cameras;
}
app.refreshCameras = refreshCameras;

navigator.mediaDevices?.addEventListener?.('devicechange', async () => {
  await refreshCameras();
  refreshLists();
  rebuildInspector();
});

$('display-select').addEventListener('change', async (e) => {
  app.outputDisplayId = Number(e.target.value);
  if (app.outputOpen) await window.zmaper.openOutput(app.outputDisplayId);
});

app.setOutputOpen = async function setOutputOpen(on) {
  if (on === app.outputOpen) return;
  if (on) {
    if (app.displays.length === 1) {
      toast('Only one display detected - the output will cover this screen. Press Esc on it to close.');
    }
    await window.zmaper.openOutput(app.outputDisplayId);
  } else {
    await window.zmaper.closeOutput();
  }
};

$('btn-output').addEventListener('click', () => app.setOutputOpen(!app.outputOpen));

window.zmaper.on('output:state', (st) => {
  app.outputOpen = st.open;
  const btn = $('btn-output');
  btn.textContent = st.open ? 'Stop Output' : 'Start Output';
  btn.classList.toggle('live', st.open);
  if (st.open) {
    window.zmaper.send({ type: 'project', payload: toOutputPayload(app.project) });
  } else {
    $('fps-label').textContent = '- fps';
  }
});

window.zmaper.on('output:report', (msg) => {
  if (msg.ready) window.zmaper.send({ type: 'project', payload: toOutputPayload(app.project) });
  if (msg.fps !== undefined) $('fps-label').textContent = `${msg.fps} fps out`;
  if (msg.mediaErrors) {
    app.outputMediaErrors = msg.mediaErrors;
    refreshLists();
    const names = Object.keys(msg.mediaErrors)
      .map((id) => app.project.media.find((m) => m.id === id)?.name)
      .filter(Boolean);
    if (names.length) toast(`Output could not play: ${names.join(', ')}`, true);
  }
});

window.zmaper.on('displays:changed', () => refreshDisplays());

// The output window owns its own playback. It deliberately does NOT follow the
// editor's video clock: the editor is routinely occluded by the fullscreen
// output, and a suspended editor pipeline would otherwise drag the projector
// into a freeze. Play/pause/restart below align both windows explicitly, which
// is the only alignment that actually matters.

// -- Project files -----------------------------------------------------------

$('btn-save').addEventListener('click', () => saveProject(false));
$('btn-open').addEventListener('click', openProject);
$('btn-new').addEventListener('click', newProject);

async function saveProject(saveAs) {
  const res = await window.zmaper.saveProject(
    {
      version: app.project.version,
      output: app.project.output,
      media: app.project.media,
      surfaces: app.project.surfaces
    },
    saveAs
  );
  if (res.ok) {
    app.dirty = false;
    toast(`Saved ${res.name}`);
  } else if (!res.canceled) {
    toast(res.error || 'Save failed', true);
  }
}

async function openProject() {
  const res = await window.zmaper.openProject();
  if (!res.ok) {
    if (!res.canceled) toast(res.error || 'Could not open project', true);
    return;
  }
  app.project = normalizeProject(res.data);
  app.selectedId = null;
  app.selectedHandles.clear();
  app.selectedMaskPoints.clear();
  app.undoStack.length = 0;
  app.redoStack.length = 0;

  // Warn about media that has moved or been deleted since the project was saved.
  const missing = [];
  for (const m of app.project.media) {
    if (m.path && !(await window.zmaper.fileExists(m.path))) missing.push(m.name);
  }

  refreshAll();
  fitView();
  toast(missing.length ? `Opened ${res.name} - missing media: ${missing.join(', ')}` : `Opened ${res.name}`, missing.length > 0);
}

async function newProject() {
  await window.zmaper.newProject();
  app.project = defaultProject();
  app.selectedId = null;
  app.selectedHandles.clear();
  app.selectedMaskPoints.clear();
  app.undoStack.length = 0;
  app.redoStack.length = 0;
  refreshAll();
  fitView();
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');

  if (e.code === 'Space' && !typing) {
    spaceDown = true;
    stage.style.cursor = 'grab';
    e.preventDefault();
  }

  if (e.ctrlKey || e.metaKey) {
    switch (e.key.toLowerCase()) {
      case 's':
        e.preventDefault();
        saveProject(e.shiftKey);
        return;
      case 'o':
        e.preventDefault();
        openProject();
        return;
      case 'n':
        e.preventDefault();
        newProject();
        return;
      case 'd': {
        e.preventDefault();
        if (app.selectedId) app.duplicateSurface(app.selectedId);
        return;
      }
      case 'z':
        e.preventDefault();
        e.shiftKey ? redo() : undo();
        return;
      case 'y':
        e.preventDefault();
        redo();
        return;
      case 'a': {
        e.preventDefault();
        const s = app.selectedSurface();
        if (s) {
          app.selectedHandles = new Set(surfacePoints(s).map((_, i) => i));
          rebuildInspector();
        }
        return;
      }
    }
  }

  if (typing) return;

  switch (e.key.toLowerCase()) {
    case 'v':
      setTool('select');
      break;
    case 'k':
      setTool('mask');
      break;
    case 'i':
      setTool('input');
      break;
    case 'q':
      addSurface('quad');
      break;
    case 'm':
      addSurface('mesh');
      break;
    case 'f':
      fitView();
      break;
    case 'delete':
    case 'backspace':
      if (app.selectedId) app.deleteSurface(app.selectedId);
      break;
    case 'escape':
      app.selectedHandles.clear();
      app.selectedMaskPoints.clear();
      break;
  }

  // Arrow-key nudging of the selection.
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (arrows[e.key]) {
    const s = app.selectedSurface();
    if (!s || s.locked) return;
    e.preventDefault();
    // One output pixel by default, 10 with Shift, sub-pixel with Alt.
    const mult = e.shiftKey ? 10 : e.altKey ? 0.25 : 1;
    const dx = (arrows[e.key][0] * mult) / app.project.output.width;
    const dy = (arrows[e.key][1] * mult) / app.project.output.height;

    app.pushUndo();
    const pts = surfacePoints(s);
    if (app.selectedHandles.size) {
      for (const i of app.selectedHandles) {
        pts[i].x += dx;
        pts[i].y += dy;
      }
    } else {
      moveSurface(s, dx, dy);
    }
    app.commit();
  }
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    spaceDown = false;
    stage.style.cursor = 'default';
  }
});

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

let toastTimer = null;
function toast(message, isError = false) {
  let node = document.querySelector('.toast');
  if (!node) {
    node = document.createElement('div');
    node.className = 'toast';
    document.body.appendChild(node);
  }
  node.textContent = message;
  node.classList.toggle('error', isError);
  requestAnimationFrame(() => node.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), isError ? 6000 : 2600);
}
app.toast = toast;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * Both windows draw every vsync, deliberately.
 *
 * Throttling the editor to 30fps while the output ran at 60 was measurably
 * worse for the projector: the two loops beat against each other and the
 * output dropped 60 frames in 14s, versus none when both run freely. Keeping
 * the editor cheap - see updatePreviewScale - is what buys the headroom.
 */
function tick() {
  if (app.tool !== 'input') {
    app.renderer.render();
    // Must run in the same frame as render(): see capturePreview().
    app.remote?.capturePreview();
  }
  drawOverlay();
  requestAnimationFrame(tick);
}

window.addEventListener('resize', () => applyTransform());

(async function boot() {
  await refreshDisplays();
  await refreshCameras();
  buildPatternButtons();
  setTool('select');
  app.remote = initRemote(app);

  // Start with one full-frame quad showing the calibration grid, so the app is
  // immediately useful for lining a projector up.
  const first = makeSurface('quad', 0);
  first.name = 'Surface 1';
  first.mediaId = app.project.media[0].id;
  app.fillOutput(first);
  app.project.surfaces.push(first);
  app.selectedId = first.id;

  app.renderer.setProject(app.project);
  refreshLists();
  rebuildInspector();
  resizeStage();
  fitView();
  requestAnimationFrame(tick);
})();
