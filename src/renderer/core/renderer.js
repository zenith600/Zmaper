'use strict';

import { squareToQuad, sampleMeshGrid, sampleMeshGridBilinear } from './math.js';
import { MediaPool, renderMaskCanvas } from './media.js';

const VERT = `#version 300 es
precision highp float;

in vec2 aParam;      // 0..1 across the surface
in vec2 aPos;        // output space 0..1 (mesh only; unused for quads)

uniform mat3  uHomography;   // unit square -> output quad
uniform int   uMode;         // 0 = quad (homography), 1 = mesh (baked positions)
uniform vec2  uOutputSize;

uniform vec4  uInputRect;    // x, y, w, h in source UV
uniform float uInputRotate;  // radians
uniform vec2  uFlip;         // 1 or -1 per axis

out vec2 vUV;
out vec2 vParam;

void main() {
  vec2 outPos;
  if (uMode == 0) {
    vec3 h = uHomography * vec3(aParam, 1.0);
    outPos = h.xy / h.z;
  } else {
    outPos = aPos;
  }

  // Source lookup: rotate/flip within the crop rect, around its centre.
  vec2 p = aParam - 0.5;
  p *= uFlip;
  float c = cos(uInputRotate);
  float s = sin(uInputRotate);
  p = vec2(p.x * c - p.y * s, p.x * s + p.y * c);
  p += 0.5;

  vUV = uInputRect.xy + p * uInputRect.zw;
  vParam = aParam;

  // Output space 0..1 (top-left origin) -> clip space.
  gl_Position = vec4(outPos.x * 2.0 - 1.0, 1.0 - outPos.y * 2.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;

in vec2 vUV;
in vec2 vParam;
out vec4 fragColor;

uniform sampler2D uTexture;
uniform sampler2D uMask;

uniform float uOpacity;
uniform vec3  uTint;
uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;
uniform float uGamma;
uniform float uGlobalBrightness;

uniform vec4  uEdge;        // left, right, top, bottom feather widths (parametric)
uniform float uEdgeGamma;
uniform float uEdgeCurve;
uniform int   uUseMask;
uniform int   uClampSource; // 1 = discard outside 0..1 UV rather than clamp

/**
 * Soft-edge blend ramp. The gamma term is what makes two overlapping
 * projectors sum to a flat field instead of a bright seam.
 */
float blendRamp(float x, float g) {
  x = clamp(x, 0.0, 1.0);
  float a = x < 0.5
    ? 0.5 * pow(2.0 * x, g)
    : 1.0 - 0.5 * pow(2.0 * (1.0 - x), g);
  return a;
}

float edgeFactor(vec2 p) {
  float a = 1.0;
  if (uEdge.x > 0.0001) a *= blendRamp(p.x / uEdge.x, uEdgeGamma);
  if (uEdge.y > 0.0001) a *= blendRamp((1.0 - p.x) / uEdge.y, uEdgeGamma);
  if (uEdge.z > 0.0001) a *= blendRamp(p.y / uEdge.z, uEdgeGamma);
  if (uEdge.w > 0.0001) a *= blendRamp((1.0 - p.y) / uEdge.w, uEdgeGamma);
  return pow(a, uEdgeCurve);
}

void main() {
  if (uClampSource == 1 && (vUV.x < 0.0 || vUV.x > 1.0 || vUV.y < 0.0 || vUV.y > 1.0)) {
    discard;
  }

  vec4 src = texture(uTexture, clamp(vUV, 0.0, 1.0));
  vec3 col = src.rgb;

  col = pow(max(col, 0.0), vec3(1.0 / max(uGamma, 0.001)));
  col = (col - 0.5) * uContrast + 0.5;
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(luma), col, uSaturation);
  col *= uTint * uBrightness * uGlobalBrightness;

  float alpha = src.a * uOpacity * edgeFactor(vParam);
  if (uUseMask == 1) alpha *= texture(uMask, vParam).r;

  fragColor = vec4(clamp(col, 0.0, 1.0) * alpha, alpha);
}`;

// Premultiplied-alpha output means every blend mode is a single blend func.
const BLEND_FUNCS = {
  normal: (gl) => gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA),
  add: (gl) => gl.blendFunc(gl.ONE, gl.ONE),
  screen: (gl) => gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR),
  multiply: (gl) => gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA)
};

const QUAD_TESS = 32; // subdivisions per axis for perspective-correct quads
const MESH_TESS = 12; // subdivisions per mesh cell

export class Renderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance'
    });
    if (!gl) throw new Error('WebGL2 is not available on this machine.');

    this.canvas = canvas;
    this.gl = gl;
    this.media = new MediaPool(gl);
    this.program = buildProgram(gl, VERT, FRAG);
    this.uniforms = collectUniforms(gl, this.program);
    this.attribs = {
      aParam: gl.getAttribLocation(this.program, 'aParam'),
      aPos: gl.getAttribLocation(this.program, 'aPos')
    };

    this.geometry = new Map(); // surfaceId -> {vao, buffers, count, hash}
    this.masks = new Map(); // surfaceId -> {texture, hash}
    this.project = null;

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
  }

  setProject(project) {
    this.project = project;
    this.media.sync(project.media || []);
    this._pruneCaches(new Set((project.surfaces || []).map((s) => s.id)));
  }

  _pruneCaches(liveIds) {
    const gl = this.gl;
    for (const [id, g] of [...this.geometry]) {
      if (!liveIds.has(id)) {
        gl.deleteVertexArray(g.vao);
        gl.deleteBuffer(g.paramBuffer);
        gl.deleteBuffer(g.posBuffer);
        gl.deleteBuffer(g.indexBuffer);
        this.geometry.delete(id);
      }
    }
    for (const [id, m] of [...this.masks]) {
      if (!liveIds.has(id)) {
        gl.deleteTexture(m.texture);
        this.masks.delete(id);
      }
    }
  }

  /**
   * Draws the whole composition.
   * @param {object} opts
   *   soloId: render only this surface
   *   onlyIds: Set of surface ids to render
   */
  render(opts = {}) {
    const gl = this.gl;
    const project = this.project;
    if (!project) return;

    this.media.update();

    const w = this.canvas.width;
    const h = this.canvas.height;
    gl.viewport(0, 0, w, h);

    const bg = project.output.backgroundColor || [0, 0, 0];
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.program);
    gl.uniform2f(this.uniforms.uOutputSize, w, h);
    gl.uniform1f(this.uniforms.uGlobalBrightness, project.output.brightness ?? 1);
    gl.uniform1i(this.uniforms.uTexture, 0);
    gl.uniform1i(this.uniforms.uMask, 1);

    const soloActive = (project.surfaces || []).some((s) => s.solo);

    for (const surface of project.surfaces || []) {
      if (!surface.visible) continue;
      if (soloActive && !surface.solo) continue;
      if (opts.onlyIds && !opts.onlyIds.has(surface.id)) continue;
      this._drawSurface(surface, project);
    }

    gl.bindVertexArray(null);
  }

  _drawSurface(surface, project) {
    const gl = this.gl;
    const u = this.uniforms;

    const geo = this._geometryFor(surface);
    if (!geo) return;

    // --- source ---------------------------------------------------------
    const mediaDef = (project.media || []).find((m) => m.id === surface.mediaId);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, mediaDef ? this.media.textureFor(mediaDef.id) : this.media.fallback);

    // --- mask -----------------------------------------------------------
    const useMask = surface.mask?.enabled && (surface.mask.points || []).length >= 3;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, useMask ? this._maskFor(surface) : this.media.fallback);
    gl.uniform1i(u.uUseMask, useMask ? 1 : 0);

    // --- warp -----------------------------------------------------------
    if (surface.type === 'quad') {
      const c = surface.corners;
      const m = squareToQuad([c[0].x, c[0].y], [c[1].x, c[1].y], [c[2].x, c[2].y], [c[3].x, c[3].y]);
      gl.uniformMatrix3fv(u.uHomography, false, m);
      gl.uniform1i(u.uMode, 0);
    } else {
      gl.uniform1i(u.uMode, 1);
    }

    // --- source crop ----------------------------------------------------
    const inp = surface.input || { x: 0, y: 0, w: 1, h: 1 };
    gl.uniform4f(u.uInputRect, inp.x, inp.y, inp.w, inp.h);
    gl.uniform1f(u.uInputRotate, ((inp.rotate || 0) * Math.PI) / 180);
    gl.uniform2f(u.uFlip, inp.flipH ? -1 : 1, inp.flipV ? -1 : 1);
    gl.uniform1i(u.uClampSource, 0);

    // --- look -----------------------------------------------------------
    gl.uniform1f(u.uOpacity, surface.opacity ?? 1);
    const tint = surface.tint || [1, 1, 1];
    gl.uniform3f(u.uTint, tint[0], tint[1], tint[2]);
    gl.uniform1f(u.uBrightness, surface.brightness ?? 1);
    gl.uniform1f(u.uContrast, surface.contrast ?? 1);
    gl.uniform1f(u.uSaturation, surface.saturation ?? 1);
    gl.uniform1f(u.uGamma, surface.gamma ?? 1);

    // --- edge blend -----------------------------------------------------
    const e = surface.edge || {};
    gl.uniform4f(u.uEdge, e.left || 0, e.right || 0, e.top || 0, e.bottom || 0);
    gl.uniform1f(u.uEdgeGamma, e.gamma ?? 2.2);
    gl.uniform1f(u.uEdgeCurve, e.curve ?? 1);

    (BLEND_FUNCS[surface.blend] || BLEND_FUNCS.normal)(gl);

    gl.bindVertexArray(geo.vao);
    gl.drawElements(gl.TRIANGLES, geo.count, gl.UNSIGNED_INT, 0);
  }

  // -- geometry ----------------------------------------------------------

  _geometryFor(surface) {
    const hash = geometryHash(surface);
    const cached = this.geometry.get(surface.id);
    if (cached && cached.hash === hash) return cached;

    const gl = this.gl;
    const built =
      surface.type === 'quad' ? buildQuadGeometry() : buildMeshGeometry(surface);

    let entry = cached;
    if (!entry) {
      entry = {
        vao: gl.createVertexArray(),
        paramBuffer: gl.createBuffer(),
        posBuffer: gl.createBuffer(),
        indexBuffer: gl.createBuffer()
      };
      this.geometry.set(surface.id, entry);
    }

    gl.bindVertexArray(entry.vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, entry.paramBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, built.params, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.attribs.aParam);
    gl.vertexAttribPointer(this.attribs.aParam, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, entry.posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, built.positions, gl.DYNAMIC_DRAW);
    if (this.attribs.aPos >= 0) {
      gl.enableVertexAttribArray(this.attribs.aPos);
      gl.vertexAttribPointer(this.attribs.aPos, 2, gl.FLOAT, false, 0, 0);
    }

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, entry.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, built.indices, gl.STATIC_DRAW);

    gl.bindVertexArray(null);

    entry.count = built.indices.length;
    entry.hash = hash;
    return entry;
  }

  _maskFor(surface) {
    const hash = JSON.stringify(surface.mask);
    const cached = this.masks.get(surface.id);
    if (cached && cached.hash === hash) return cached.texture;

    const gl = this.gl;
    const canvas = renderMaskCanvas(surface.mask, 512);
    let tex = cached?.texture;
    if (!tex) {
      tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, tex);
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);

    this.masks.set(surface.id, { texture: tex, hash });
    return tex;
  }

  resize(width, height) {
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
  }

  destroy() {
    this.media.destroy();
    this._pruneCaches(new Set());
    this.gl.deleteProgram(this.program);
  }
}

// ---------------------------------------------------------------------------
// Geometry builders
// ---------------------------------------------------------------------------

/**
 * A quad is a uniform grid in parametric space; the vertex shader pushes each
 * vertex through the homography, which keeps texturing perspective-correct.
 */
function buildQuadGeometry() {
  const n = QUAD_TESS;
  const params = new Float32Array((n + 1) * (n + 1) * 2);
  let k = 0;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      params[k++] = i / n;
      params[k++] = j / n;
    }
  }
  return {
    params,
    positions: new Float32Array(params.length), // unused in quad mode
    indices: gridIndices(n, n)
  };
}

/** A mesh bakes its warped positions on the CPU, sampled off the control grid. */
function buildMeshGeometry(surface) {
  const n = Math.max(2, Math.min(surface.cols * MESH_TESS, 192));
  const m = Math.max(2, Math.min(surface.rows * MESH_TESS, 192));
  const sample = surface.interpolation === 'linear' ? sampleMeshGridBilinear : sampleMeshGrid;

  const params = new Float32Array((n + 1) * (m + 1) * 2);
  const positions = new Float32Array((n + 1) * (m + 1) * 2);
  let k = 0;
  for (let j = 0; j <= m; j++) {
    for (let i = 0; i <= n; i++) {
      const s = i / n;
      const t = j / m;
      const [x, y] = sample(surface.points, surface.cols, surface.rows, s, t);
      params[k] = s;
      params[k + 1] = t;
      positions[k] = x;
      positions[k + 1] = y;
      k += 2;
    }
  }

  return { params, positions, indices: gridIndices(n, m) };
}

function gridIndices(n, m) {
  const idx = new Uint32Array(n * m * 6);
  let k = 0;
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      const b = a + 1;
      const c = a + (n + 1);
      const d = c + 1;
      idx[k++] = a;
      idx[k++] = b;
      idx[k++] = c;
      idx[k++] = b;
      idx[k++] = d;
      idx[k++] = c;
    }
  }
  return idx;
}

/** Only rebuild geometry when something that changes vertices changes. */
function geometryHash(surface) {
  if (surface.type === 'quad') return 'quad';
  return (
    surface.interpolation +
    ':' +
    surface.cols +
    'x' +
    surface.rows +
    ':' +
    surface.points.map((p) => `${p.x.toFixed(5)},${p.y.toFixed(5)}`).join(';')
  );
}

// ---------------------------------------------------------------------------
// GL plumbing
// ---------------------------------------------------------------------------

function buildProgram(gl, vsSource, fsSource) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSource);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error('Shader link failed: ' + gl.getProgramInfoLog(prog));
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return prog;
}

function compile(gl, type, source) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

function collectUniforms(gl, program) {
  const out = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i);
    out[info.name] = gl.getUniformLocation(program, info.name);
  }
  return out;
}
