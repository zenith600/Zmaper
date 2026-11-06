'use strict';

/**
 * Geometry helpers for warping.
 *
 * Coordinate convention used throughout the app:
 *   - "output space" is normalised 0..1 across the output canvas, origin top-left.
 *   - "parametric space" (s,t) is 0..1 across a surface, origin top-left.
 *   - "input space" (u,v) is 0..1 across the source texture, origin top-left.
 */

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Heckbert's projective map from the unit square to an arbitrary convex quad.
 * Corners are ordered (0,0) (1,0) (1,1) (0,1) -> p0 p1 p2 p3.
 *
 * Returns the 9 coefficients of
 *   x = (a*s + b*t + c) / (g*s + h*t + 1)
 *   y = (d*s + e*t + f) / (g*s + h*t + 1)
 * as a column-major mat3 ready for a WebGL uniform.
 */
export function squareToQuad(p0, p1, p2, p3) {
  const [x0, y0] = p0;
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  const [x3, y3] = p3;

  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;

  let a, b, c, d, e, f, g, h;

  if (Math.abs(sx) < 1e-12 && Math.abs(sy) < 1e-12) {
    // Affine (parallelogram) case.
    a = x1 - x0;
    b = x2 - x1;
    c = x0;
    d = y1 - y0;
    e = y2 - y1;
    f = y0;
    g = 0;
    h = 0;
  } else {
    const dx1 = x1 - x2;
    const dx2 = x3 - x2;
    const dy1 = y1 - y2;
    const dy2 = y3 - y2;
    let den = dx1 * dy2 - dy1 * dx2;
    if (Math.abs(den) < 1e-12) den = 1e-12; // degenerate quad; avoid a NaN cascade

    g = (sx * dy2 - sy * dx2) / den;
    h = (dx1 * sy - dy1 * sx) / den;
    a = x1 - x0 + g * x1;
    b = x3 - x0 + h * x3;
    c = x0;
    d = y1 - y0 + g * y1;
    e = y3 - y0 + h * y3;
    f = y0;
  }

  // Column-major mat3: columns are (a,d,g) (b,e,h) (c,f,1).
  return new Float32Array([a, d, g, b, e, h, c, f, 1]);
}

/** Applies a mat3 (column-major, as produced above) to a parametric point. */
export function applyHomography(m, s, t) {
  const x = m[0] * s + m[3] * t + m[6];
  const y = m[1] * s + m[4] * t + m[7];
  let w = m[2] * s + m[5] * t + m[8];
  if (Math.abs(w) < 1e-12) w = 1e-12;
  return [x / w, y / w];
}

/** Catmull-Rom basis for one axis. */
function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/**
 * Samples a control-point grid as a smooth Catmull-Rom patch.
 *
 * @param {Array<{x:number,y:number}>} pts  (cols+1)*(rows+1) points, row-major.
 * @param {number} cols  cell count horizontally
 * @param {number} rows  cell count vertically
 * @param {number} s  0..1 across the grid
 * @param {number} t  0..1 down the grid
 */
export function sampleMeshGrid(pts, cols, rows, s, t) {
  const nx = cols + 1;
  const ny = rows + 1;

  const gx = clamp(s, 0, 1) * cols;
  const gy = clamp(t, 0, 1) * rows;

  // Cell index, kept inside the grid so the local parameter stays in 0..1.
  const i = Math.min(Math.floor(gx), cols - 1);
  const j = Math.min(Math.floor(gy), rows - 1);
  const fx = gx - i;
  const fy = gy - j;

  const at = (cx, cy) => {
    const x = clamp(cx, 0, nx - 1);
    const y = clamp(cy, 0, ny - 1);
    return pts[y * nx + x];
  };

  // Interpolate four rows horizontally, then those results vertically.
  const colX = [];
  const colY = [];
  for (let r = -1; r <= 2; r++) {
    const a = at(i - 1, j + r);
    const b = at(i, j + r);
    const c = at(i + 1, j + r);
    const d = at(i + 2, j + r);
    colX.push(catmullRom(a.x, b.x, c.x, d.x, fx));
    colY.push(catmullRom(a.y, b.y, c.y, d.y, fx));
  }

  return [
    catmullRom(colX[0], colX[1], colX[2], colX[3], fy),
    catmullRom(colY[0], colY[1], colY[2], colY[3], fy)
  ];
}

/** Bilinear sample of the same grid - used for straight-line mesh mode. */
export function sampleMeshGridBilinear(pts, cols, rows, s, t) {
  const nx = cols + 1;
  const gx = clamp(s, 0, 1) * cols;
  const gy = clamp(t, 0, 1) * rows;
  const i = Math.min(Math.floor(gx), cols - 1);
  const j = Math.min(Math.floor(gy), rows - 1);
  const fx = gx - i;
  const fy = gy - j;

  const p00 = pts[j * nx + i];
  const p10 = pts[j * nx + i + 1];
  const p01 = pts[(j + 1) * nx + i];
  const p11 = pts[(j + 1) * nx + i + 1];

  return [
    lerp(lerp(p00.x, p10.x, fx), lerp(p01.x, p11.x, fx), fy),
    lerp(lerp(p00.y, p10.y, fx), lerp(p01.y, p11.y, fx), fy)
  ];
}

/** Distance from a point to a segment, in the same units as the inputs. */
export function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Even-odd point-in-polygon test. `poly` is [{x,y}, ...]. */
export function pointInPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersects = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi || 1e-12) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Axis-aligned bounds of a point list. */
export function boundsOf(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}
