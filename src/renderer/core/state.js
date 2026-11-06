'use strict';

import { sampleMeshGrid } from './math.js';

/**
 * Project model. Everything here is plain JSON so it can be written to a
 * .zmap file and broadcast to the output window verbatim.
 */

export const PROJECT_VERSION = 1;

let idCounter = 1;
export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;
}

export const BLEND_MODES = ['normal', 'add', 'screen', 'multiply'];

export function defaultProject() {
  return {
    version: PROJECT_VERSION,
    output: {
      width: 1920,
      height: 1080,
      backgroundColor: [0, 0, 0],
      brightness: 1,
      testPattern: false
    },
    media: [
      makeMedia({ kind: 'pattern', pattern: 'grid', name: 'Calibration Grid' }),
      makeMedia({ kind: 'color', color: [1, 1, 1], name: 'White' })
    ],
    surfaces: [],
    selection: { surfaceId: null, handles: [] }
  };
}

/**
 * @param {object} opts
 *   kind: 'video' | 'image' | 'webcam' | 'pattern' | 'color'
 */
export function makeMedia(opts = {}) {
  return {
    id: uid('m'),
    kind: opts.kind || 'pattern',
    name: opts.name || 'Media',
    path: opts.path || null,
    url: opts.url || null,
    deviceId: opts.deviceId || null,
    pattern: opts.pattern || 'grid',
    color: opts.color || [1, 1, 1],
    loop: opts.loop !== undefined ? opts.loop : true,
    muted: opts.muted !== undefined ? opts.muted : true,
    volume: opts.volume !== undefined ? opts.volume : 1,
    rate: opts.rate || 1,
    width: opts.width || 0,
    height: opts.height || 0
  };
}

/**
 * Creates a surface. `type` is 'quad' or 'mesh'.
 * Output coordinates are normalised 0..1 of the output canvas.
 */
export function makeSurface(type = 'quad', index = 0, opts = {}) {
  // Stagger new surfaces so they do not stack invisibly on top of each other.
  const step = (index % 6) * 0.04;
  const x = 0.2 + step;
  const y = 0.2 + step;
  const w = opts.w || 0.4;
  const h = opts.h || 0.4;

  const base = {
    id: uid('s'),
    name: type === 'mesh' ? `Mesh ${index + 1}` : `Quad ${index + 1}`,
    type,
    visible: true,
    locked: false,
    solo: false,
    mediaId: opts.mediaId || null,

    // Source crop, in input (u,v) space.
    input: { x: 0, y: 0, w: 1, h: 1, rotate: 0, flipH: false, flipV: false },

    // Appearance
    opacity: 1,
    blend: 'normal',
    tint: [1, 1, 1],
    brightness: 1,
    contrast: 1,
    saturation: 1,
    gamma: 1,

    // Soft-edge blending, as a fraction of the surface in parametric space.
    edge: { left: 0, right: 0, top: 0, bottom: 0, gamma: 2.2, curve: 1 },

    // Polygon mask in parametric space; empty = no mask.
    mask: { enabled: false, invert: false, feather: 0.02, points: [] },

    // Mesh smoothing: 'smooth' (Catmull-Rom) or 'linear'
    interpolation: 'smooth'
  };

  if (type === 'quad') {
    base.corners = [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h }
    ];
  } else {
    const cols = opts.cols || 3;
    const rows = opts.rows || 3;
    base.cols = cols;
    base.rows = rows;
    base.points = [];
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= cols; i++) {
        base.points.push({ x: x + (i / cols) * w, y: y + (j / rows) * h });
      }
    }
  }

  return base;
}

/** Rebuilds a mesh's control points at a new resolution, preserving its shape. */
export function resampleMesh(surface, cols, rows) {
  const next = [];
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const [x, y] = sampleMeshGrid(surface.points, surface.cols, surface.rows, i / cols, j / rows);
      next.push({ x, y });
    }
  }
  surface.points = next;
  surface.cols = cols;
  surface.rows = rows;
}

/** Converts a quad surface into an equivalent 2x2 mesh (and back). */
export function convertSurfaceType(surface, toType) {
  if (surface.type === toType) return surface;

  if (toType === 'mesh') {
    const [p0, p1, p2, p3] = surface.corners;
    const cols = 3;
    const rows = 3;
    const pts = [];
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= cols; i++) {
        const s = i / cols;
        const t = j / rows;
        // Bilinear from the quad corners keeps the visible shape identical
        // for affine quads and very close for perspective ones.
        const top = { x: p0.x + (p1.x - p0.x) * s, y: p0.y + (p1.y - p0.y) * s };
        const bot = { x: p3.x + (p2.x - p3.x) * s, y: p3.y + (p2.y - p3.y) * s };
        pts.push({ x: top.x + (bot.x - top.x) * t, y: top.y + (bot.y - top.y) * t });
      }
    }
    delete surface.corners;
    surface.points = pts;
    surface.cols = cols;
    surface.rows = rows;
    surface.type = 'mesh';
  } else {
    const nx = surface.cols + 1;
    const p = surface.points;
    surface.corners = [
      { ...p[0] },
      { ...p[nx - 1] },
      { ...p[p.length - 1] },
      { ...p[p.length - nx] }
    ];
    delete surface.points;
    delete surface.cols;
    delete surface.rows;
    surface.type = 'quad';
  }
  return surface;
}

/** All draggable control points of a surface, as a flat list. */
export function surfacePoints(surface) {
  return surface.type === 'quad' ? surface.corners : surface.points;
}

/** Migrates/repairs a loaded project so older or hand-edited files still open. */
export function normalizeProject(raw) {
  const base = defaultProject();
  if (!raw || typeof raw !== 'object') return base;

  const p = {
    version: PROJECT_VERSION,
    output: { ...base.output, ...(raw.output || {}) },
    media: Array.isArray(raw.media) ? raw.media.map((m) => ({ ...makeMedia(), ...m })) : base.media,
    surfaces: Array.isArray(raw.surfaces) ? raw.surfaces : [],
    selection: { surfaceId: null, handles: [] }
  };

  p.surfaces = p.surfaces
    .map((s) => {
      const tpl = makeSurface(s.type === 'mesh' ? 'mesh' : 'quad', 0);
      const merged = {
        ...tpl,
        ...s,
        input: { ...tpl.input, ...(s.input || {}) },
        edge: { ...tpl.edge, ...(s.edge || {}) },
        mask: { ...tpl.mask, ...(s.mask || {}) }
      };
      if (merged.type === 'quad') {
        if (!Array.isArray(merged.corners) || merged.corners.length !== 4) merged.corners = tpl.corners;
        delete merged.points;
      } else {
        const expected = (merged.cols + 1) * (merged.rows + 1);
        if (!Array.isArray(merged.points) || merged.points.length !== expected) {
          merged.cols = tpl.cols;
          merged.rows = tpl.rows;
          merged.points = tpl.points;
        }
        delete merged.corners;
      }
      return merged;
    })
    .filter(Boolean);

  // Drop surface references to media that no longer exists.
  const mediaIds = new Set(p.media.map((m) => m.id));
  for (const s of p.surfaces) if (s.mediaId && !mediaIds.has(s.mediaId)) s.mediaId = null;

  return p;
}

/** The payload sent to the output window - state only, no editor concerns. */
export function toOutputPayload(project) {
  return {
    output: project.output,
    media: project.media,
    surfaces: project.surfaces.filter((s) => s.visible)
  };
}
