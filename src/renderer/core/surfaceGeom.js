'use strict';

import {
  squareToQuad,
  applyHomography,
  sampleMeshGrid,
  sampleMeshGridBilinear,
  clamp
} from './math.js';

/**
 * Maps between a surface's parametric space (s,t in 0..1) and normalised
 * output space. The editor needs both directions: forward to draw overlays,
 * inverse to turn a mouse position into a mask point.
 */

export function paramToOutput(surface, s, t) {
  if (surface.type === 'quad') {
    const c = surface.corners;
    const m = squareToQuad([c[0].x, c[0].y], [c[1].x, c[1].y], [c[2].x, c[2].y], [c[3].x, c[3].y]);
    return applyHomography(m, s, t);
  }
  const sample = surface.interpolation === 'linear' ? sampleMeshGridBilinear : sampleMeshGrid;
  return sample(surface.points, surface.cols, surface.rows, s, t);
}

/** Inverse of a 3x3 column-major matrix; returns null if singular. */
function invert3(m) {
  const [a, d, g, b, e, h, c, f, i] = m;
  const A = e * i - h * f;
  const B = -(b * i - h * c);
  const C = b * f - e * c;
  const det = a * A + d * B + g * C;
  if (Math.abs(det) < 1e-14) return null;
  const inv = 1 / det;
  return [
    A * inv,
    (-(d * i - g * f)) * inv,
    (d * h - g * e) * inv,
    B * inv,
    (a * i - g * c) * inv,
    (-(a * h - g * b)) * inv,
    C * inv,
    (-(a * f - d * c)) * inv,
    (a * e - d * b) * inv
  ];
}

export function outputToParam(surface, x, y) {
  if (surface.type === 'quad') {
    const c = surface.corners;
    const m = squareToQuad([c[0].x, c[0].y], [c[1].x, c[1].y], [c[2].x, c[2].y], [c[3].x, c[3].y]);
    const inv = invert3(m);
    if (!inv) return [0.5, 0.5];
    const s = inv[0] * x + inv[3] * y + inv[6];
    const t = inv[1] * x + inv[4] * y + inv[7];
    let w = inv[2] * x + inv[5] * y + inv[8];
    if (Math.abs(w) < 1e-12) w = 1e-12;
    return [s / w, t / w];
  }

  // Meshes have no closed-form inverse: seed with a coarse scan, then refine
  // with a few Gauss-Newton steps against the forward map.
  const N = 24;
  let bestS = 0.5;
  let bestT = 0.5;
  let bestD = Infinity;
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const s = i / N;
      const t = j / N;
      const [px, py] = paramToOutput(surface, s, t);
      const d = (px - x) * (px - x) + (py - y) * (py - y);
      if (d < bestD) {
        bestD = d;
        bestS = s;
        bestT = t;
      }
    }
  }

  const eps = 1e-3;
  for (let iter = 0; iter < 12; iter++) {
    const [px, py] = paramToOutput(surface, bestS, bestT);
    const rx = px - x;
    const ry = py - y;
    if (rx * rx + ry * ry < 1e-12) break;

    const [sx, sy] = paramToOutput(surface, clamp(bestS + eps, 0, 1), bestT);
    const [tx, ty] = paramToOutput(surface, bestS, clamp(bestT + eps, 0, 1));
    const j11 = (sx - px) / eps;
    const j21 = (sy - py) / eps;
    const j12 = (tx - px) / eps;
    const j22 = (ty - py) / eps;

    const det = j11 * j22 - j12 * j21;
    if (Math.abs(det) < 1e-12) break;
    const ds = (j22 * rx - j12 * ry) / det;
    const dt = (-j21 * rx + j11 * ry) / det;

    bestS = clamp(bestS - ds, -0.5, 1.5);
    bestT = clamp(bestT - dt, -0.5, 1.5);
  }

  return [bestS, bestT];
}

/** Outline of a surface in output space, densely sampled so warps show. */
export function surfaceOutline(surface, stepsPerEdge = 16) {
  const pts = [];
  const push = (s, t) => {
    const [x, y] = paramToOutput(surface, s, t);
    pts.push({ x, y });
  };
  for (let i = 0; i < stepsPerEdge; i++) push(i / stepsPerEdge, 0);
  for (let i = 0; i < stepsPerEdge; i++) push(1, i / stepsPerEdge);
  for (let i = stepsPerEdge; i > 0; i--) push(i / stepsPerEdge, 1);
  for (let i = stepsPerEdge; i > 0; i--) push(0, i / stepsPerEdge);
  return pts;
}

/** Centroid of the control points - used as the anchor for move/scale. */
export function surfaceCenter(surface) {
  const pts = surface.type === 'quad' ? surface.corners : surface.points;
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}

/** Translates every control point. */
export function moveSurface(surface, dx, dy) {
  const pts = surface.type === 'quad' ? surface.corners : surface.points;
  for (const p of pts) {
    p.x += dx;
    p.y += dy;
  }
}

/** Scales every control point about the surface centre. */
export function scaleSurface(surface, factor) {
  const c = surfaceCenter(surface);
  const pts = surface.type === 'quad' ? surface.corners : surface.points;
  for (const p of pts) {
    p.x = c.x + (p.x - c.x) * factor;
    p.y = c.y + (p.y - c.y) * factor;
  }
}

/** Rotates every control point about the surface centre, in degrees. */
export function rotateSurface(surface, degrees, aspect = 16 / 9) {
  const c = surfaceCenter(surface);
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const pts = surface.type === 'quad' ? surface.corners : surface.points;
  for (const p of pts) {
    // Work in square units so a rotation does not shear on a 16:9 canvas.
    const dx = (p.x - c.x) * aspect;
    const dy = p.y - c.y;
    p.x = c.x + (dx * cos - dy * sin) / aspect;
    p.y = c.y + (dx * sin + dy * cos);
  }
}

/** Resets a surface to an axis-aligned rectangle covering its current bounds. */
export function resetSurfaceShape(surface) {
  const pts = surface.type === 'quad' ? surface.corners : surface.points;
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
  const w = maxX - minX;
  const h = maxY - minY;

  if (surface.type === 'quad') {
    surface.corners = [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY }
    ];
  } else {
    const next = [];
    for (let j = 0; j <= surface.rows; j++) {
      for (let i = 0; i <= surface.cols; i++) {
        next.push({ x: minX + (i / surface.cols) * w, y: minY + (j / surface.rows) * h });
      }
    }
    surface.points = next;
  }
}
