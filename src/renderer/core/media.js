'use strict';

/**
 * Owns the actual decoded media (video elements, images, webcam streams,
 * generated patterns) and keeps one GL texture per media item up to date.
 *
 * The editor window and the output window each run their own MediaPool against
 * the same project JSON, so neither has to share GPU resources with the other.
 */
export class MediaPool {
  /** Let Chromium's own `loop` wrap clips instead of seeking them manually. */
  static nativeLoop = false;

  /** @param {WebGL2RenderingContext} gl */
  constructor(gl) {
    this.gl = gl;
    /** @type {Map<string, object>} */
    this.entries = new Map();
    this.fallback = this._makeSolidTexture([32, 32, 38, 255]);
  }

  /** Reconciles the pool against the project's media list. */
  sync(mediaList) {
    const seen = new Set();
    for (const def of mediaList) {
      seen.add(def.id);
      const existing = this.entries.get(def.id);
      // Compare against the signature captured when the entry was built, not
      // against `existing.def` - that is the very object the editor mutates in
      // place when you drop a new file onto an existing media row, so the two
      // would always be identical and the texture would never rebuild.
      if (!existing || existing.signature !== this._signature(def)) {
        if (existing) this._dispose(existing);
        this.entries.set(def.id, this._create(def));
      } else {
        existing.def = def;
        this._applyPlaybackSettings(existing);
      }
    }
    for (const [id, entry] of [...this.entries]) {
      if (!seen.has(id)) {
        this._dispose(entry);
        this.entries.delete(id);
      }
    }
  }

  /** Identity of the *source*: changing any of these requires a rebuild. */
  _signature(def) {
    return [def.kind, def.url || '', def.deviceId || '', def.pattern || '', (def.color || []).join(',')].join('|');
  }

  _create(def) {
    const gl = this.gl;
    const entry = {
      def,
      signature: this._signature(def),
      texture: gl.createTexture(),
      element: null,
      ready: false,
      width: 1,
      height: 1,
      needsUpload: true,
      error: null
    };

    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([20, 20, 24, 255]));

    switch (def.kind) {
      case 'video':
        this._initVideo(entry);
        break;
      case 'image':
        this._initImage(entry);
        break;
      case 'webcam':
        this._initWebcam(entry);
        break;
      case 'pattern':
        this._initCanvasSource(entry, () => drawPattern(def.pattern, 1024, 1024));
        break;
      case 'color':
      default:
        this._initCanvasSource(entry, () => drawSolid(def.color));
        break;
    }

    return entry;
  }

  _initVideo(entry) {
    const v = document.createElement('video');
    // No crossOrigin: these are file:// URLs loaded by a file:// page. Asking
    // for a CORS fetch there pushes the media onto a loader that re-reads from
    // the start on every seek, which made each loop wrap take seconds.
    v.src = entry.def.url;
    v.loop = entry.def.loop !== false;
    v.muted = entry.def.muted !== false;
    v.volume = entry.def.volume ?? 1;
    v.playbackRate = entry.def.rate || 1;
    v.playsInline = true;
    v.preload = 'auto';
    v.addEventListener('loadedmetadata', () => {
      entry.width = v.videoWidth;
      entry.height = v.videoHeight;
      entry.ready = true;
    });
    v.addEventListener('error', () => {
      entry.error = 'Could not decode video';
    });
    entry.element = v;
    entry.isVideo = true;
    entry.wantPlaying = true;
    v.play().catch(() => {
      /* refused for now; _recoverIfStalled keeps retrying */
    });
  }

  _initWebcam(entry) {
    const v = document.createElement('video');
    v.autoplay = true;
    v.muted = true;
    v.playsInline = true;
    entry.element = v;
    entry.isVideo = true;

    const constraints = entry.def.deviceId
      ? { video: { deviceId: { exact: entry.def.deviceId } }, audio: false }
      : { video: true, audio: false };

    navigator.mediaDevices
      .getUserMedia(constraints)
      .then((stream) => {
        entry.stream = stream;
        v.srcObject = stream;
        return v.play();
      })
      .then(() => {
        entry.width = v.videoWidth || 1280;
        entry.height = v.videoHeight || 720;
        entry.ready = true;
      })
      .catch((err) => {
        entry.error = `Camera unavailable: ${err.message}`;
      });
  }

  _initImage(entry) {
    const img = new Image();
    img.onload = () => {
      entry.element = img;
      entry.width = img.naturalWidth;
      entry.height = img.naturalHeight;
      entry.ready = true;
      entry.needsUpload = true;
    };
    img.onerror = () => {
      entry.error = 'Could not load image';
    };
    img.src = entry.def.url;
  }

  _initCanvasSource(entry, draw) {
    const canvas = draw();
    entry.element = canvas;
    entry.width = canvas.width;
    entry.height = canvas.height;
    entry.ready = true;
    entry.needsUpload = true;
  }

  _applyPlaybackSettings(entry) {
    const el = entry.element;
    if (!el || !entry.isVideo || entry.def.kind === 'webcam') return;
    if (el.loop !== (entry.def.loop !== false)) el.loop = entry.def.loop !== false;
    if (el.muted !== (entry.def.muted !== false)) el.muted = entry.def.muted !== false;
    const vol = entry.def.volume ?? 1;
    if (Math.abs(el.volume - vol) > 0.001) el.volume = vol;
    const rate = entry.def.rate || 1;
    if (Math.abs(el.playbackRate - rate) > 0.001) el.playbackRate = rate;
  }

  /** Uploads any frames that changed. Call once per rendered frame. */
  update() {
    const gl = this.gl;
    const now = performance.now();
    for (const entry of this.entries.values()) {
      if (!entry.ready || !entry.element) continue;
      this._recoverIfStalled(entry, now);

      const isLiveFrame = entry.isVideo && entry.element.readyState >= 2;
      if (!isLiveFrame && !entry.needsUpload) continue;

      gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      try {
        const el = entry.element;
        const w = el.videoWidth || el.naturalWidth || el.width || 0;
        const h = el.videoHeight || el.naturalHeight || el.height || 0;

        // texImage2D reallocates the texture store every call. Once the size
        // is known and unchanged, texSubImage2D overwrites it in place.
        if (w && h && entry.texW === w && entry.texH === h) {
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, el);
        } else {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el);
          entry.texW = w;
          entry.texH = h;
        }

        if (entry.isVideo) {
          entry.width = el.videoWidth || entry.width;
          entry.height = el.videoHeight || entry.height;
        }
        entry.needsUpload = false;
      } catch {
        entry.needsUpload = false;
      }
    }
  }

  /**
   * Restarts a video that claims to be playing but whose clock has stopped.
   *
   * Chromium suspends a renderer's media pipeline when its window is occluded
   * - which is exactly what happens to the editor the moment a fullscreen
   * output window covers it on a single-display machine. A looping clip that
   * reaches its end while suspended never completes the seek back to zero and
   * wedges at `duration` with paused === false, so nothing ever restarts it.
   */
  _recoverIfStalled(entry, now) {
    const v = entry.element;
    if (!entry.isVideo || entry.def.kind !== 'video' || !v) return;

    // A clip the user deliberately paused is left alone.
    if (!entry.wantPlaying) {
      entry.stuckSince = 0;
      entry.lastClock = v.currentTime;
      return;
    }

    // A seek in flight is normal, not a stall - wrapping a loop is a seek.
    // Counting it as stuck made the watchdog reload the element in the middle
    // of every loop, turning a brief wrap into a second-long freeze. Give
    // seeks room, and only treat one as wedged if it never finishes.
    if (v.seeking) {
      if (!entry.seekingSince) entry.seekingSince = now;
      if (now - entry.seekingSince > 3000 && (!entry.lastReload || now - entry.lastReload > 4000)) {
        entry.lastReload = now;
        entry.seekingSince = now;
        try {
          v.load();
          v.play().catch(() => {});
        } catch {
          /* retried on the next pass */
        }
      }
      entry.stuckSince = 0;
      return;
    }
    entry.seekingSince = 0;

    const moving = v.currentTime !== entry.lastClock;
    entry.lastClock = v.currentTime;

    if (moving && !v.paused) {
      entry.stuckSince = 0;

      // Wrap a couple of frames early rather than letting the element reach
      // its final frame: arriving at EOF is what wedges the pipeline. The
      // frames skipped are not perceivable.
      if (
        !MediaPool.nativeLoop &&
        v.loop &&
        Number.isFinite(v.duration) &&
        v.duration > 0.5 &&
        v.duration - v.currentTime < 0.12
      ) {
        try {
          v.currentTime = 0;
          v.play().catch(() => {});
        } catch {
          /* the escalation below is the fallback */
        }
      }
      return;
    }

    // --- not making progress -------------------------------------------
    if (!entry.stuckSince) {
      entry.stuckSince = now;
      return;
    }
    const stuckFor = now - entry.stuckSince;

    // Cheap nudges first: an autoplay that was refused, or a loop that
    // reached the last frame and never wrapped.
    if (stuckFor > 200 && (!entry.lastNudge || now - entry.lastNudge > 400)) {
      entry.lastNudge = now;
      if (!v.seeking && v.readyState >= 2) {
        if (v.paused) {
          v.play().catch(() => {});
          return;
        }
        if (v.loop && Number.isFinite(v.duration) && v.currentTime >= v.duration - 0.25) {
          try {
            v.currentTime = 0;
          } catch {
            /* escalation below */
          }
          return;
        }
      }
    }

    // Last resort. A seek can simply never complete - the element then sits
    // with seeking === true and readyState back at HAVE_METADATA even though
    // the whole file is buffered, and no amount of play() or re-seeking moves
    // it. Reloading the element is the only way out of that state.
    if (stuckFor > 1500 && (!entry.lastReload || now - entry.lastReload > 4000)) {
      entry.lastReload = now;
      entry.stuckSince = now;
      try {
        v.load();
        v.play().catch(() => {});
      } catch {
        /* retried on the next pass */
      }
    }
  }

  get(id) {
    return this.entries.get(id) || null;
  }

  textureFor(id) {
    const e = this.entries.get(id);
    return e && e.ready ? e.texture : this.fallback;
  }

  // -- transport ----------------------------------------------------------

  play(id) {
    this._setWanted(id, true);
    this._eachVideo(id, (v) => v.play().catch(() => {}));
  }

  pause(id) {
    this._setWanted(id, false);
    this._eachVideo(id, (v) => v.pause());
  }

  /**
   * Records whether a clip is *meant* to be running, which is what lets the
   * watchdog tell "autoplay was refused" from "the user pressed Pause".
   */
  _setWanted(id, wanted) {
    for (const [entryId, e] of this.entries) {
      if (id && entryId !== id) continue;
      if (e.isVideo && e.def.kind === 'video') e.wantPlaying = wanted;
    }
  }

  /** Media that failed to load or decode, as {id: message}. */
  errors() {
    const out = {};
    for (const [id, e] of this.entries) if (e.error) out[id] = e.error;
    return out;
  }

  seek(id, time) {
    this._eachVideo(id, (v) => {
      if (Number.isFinite(v.duration)) v.currentTime = Math.max(0, Math.min(time, v.duration));
    });
  }

  _eachVideo(id, fn) {
    if (id) {
      const e = this.entries.get(id);
      if (e && e.isVideo && e.def.kind === 'video' && e.element) fn(e.element);
      return;
    }
    for (const e of this.entries.values()) {
      if (e.isVideo && e.def.kind === 'video' && e.element) fn(e.element);
    }
  }

  _makeSolidTexture(rgba) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  _dispose(entry) {
    entry.disposed = true;

    if (entry.stream) for (const t of entry.stream.getTracks()) t.stop();
    if (entry.element && entry.isVideo) {
      entry.element.pause?.();
      entry.element.removeAttribute?.('src');
      entry.element.srcObject = null;
      entry.element.load?.();
    }
    if (entry.texture) this.gl.deleteTexture(entry.texture);
  }

  destroy() {
    for (const e of this.entries.values()) this._dispose(e);
    this.entries.clear();
  }
}

// ---------------------------------------------------------------------------
// Generated sources
// ---------------------------------------------------------------------------

function drawSolid(color) {
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 16;
  const ctx = c.getContext('2d');
  const [r, g, b] = color || [1, 1, 1];
  ctx.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
  ctx.fillRect(0, 0, 16, 16);
  return c;
}

export const PATTERNS = ['grid', 'checker', 'bars', 'circles', 'crosshair', 'gradient', 'linearity'];

/** Calibration patterns. These are what you actually align a projector with. */
export function drawPattern(name, w = 1024, h = 1024) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);

  switch (name) {
    case 'checker': {
      const n = 8;
      const cw = w / n;
      const ch = h / n;
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          ctx.fillStyle = (i + j) % 2 ? '#ffffff' : '#111111';
          ctx.fillRect(i * cw, j * ch, cw + 1, ch + 1);
        }
      }
      break;
    }

    case 'bars': {
      const colors = ['#ffffff', '#ffff00', '#00ffff', '#00ff00', '#ff00ff', '#ff0000', '#0000ff', '#000000'];
      const bw = w / colors.length;
      colors.forEach((col, i) => {
        ctx.fillStyle = col;
        ctx.fillRect(i * bw, 0, bw + 1, h * 0.75);
      });
      // Greyscale ramp strip along the bottom for gamma checks.
      const steps = 16;
      for (let i = 0; i < steps; i++) {
        const v = Math.round((i / (steps - 1)) * 255);
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.fillRect((i / steps) * w, h * 0.75, w / steps + 1, h * 0.25);
      }
      break;
    }

    case 'circles': {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(2, w / 400);
      const cx = w / 2;
      const cy = h / 2;
      const max = Math.min(w, h) / 2;
      for (let r = max / 12; r <= max; r += max / 12) {
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      break;
    }

    case 'crosshair': {
      ctx.strokeStyle = '#00ff88';
      ctx.lineWidth = Math.max(2, w / 400);
      ctx.beginPath();
      ctx.moveTo(w / 2, 0);
      ctx.lineTo(w / 2, h);
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.moveTo(0, 0);
      ctx.lineTo(w, h);
      ctx.moveTo(w, 0);
      ctx.lineTo(0, h);
      ctx.stroke();
      ctx.strokeStyle = '#ffffff';
      ctx.strokeRect(ctx.lineWidth, ctx.lineWidth, w - ctx.lineWidth * 2, h - ctx.lineWidth * 2);
      break;
    }

    case 'gradient': {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#000000');
      g.addColorStop(0.5, '#7a7a7a');
      g.addColorStop(1, '#ffffff');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      break;
    }

    case 'linearity': {
      // Concentric squares - the fastest way to spot keystone/pincushion error.
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(2, w / 500);
      for (let i = 1; i <= 8; i++) {
        const f = i / 16;
        ctx.strokeRect(w * f, h * f, w * (1 - f * 2), h * (1 - f * 2));
      }
      break;
    }

    case 'grid':
    default: {
      const n = 16;
      ctx.strokeStyle = '#2f6bff';
      ctx.lineWidth = Math.max(1, w / 1000);
      ctx.beginPath();
      for (let i = 0; i <= n; i++) {
        const x = (i / n) * w;
        const y = (i / n) * h;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
      }
      ctx.stroke();

      // Bright border + diagonals so corner alignment is unambiguous.
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(3, w / 250);
      ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth);
      ctx.strokeStyle = '#ff3b6b';
      ctx.lineWidth = Math.max(2, w / 500);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(w, h);
      ctx.moveTo(w, 0);
      ctx.lineTo(0, h);
      ctx.stroke();

      // Corner labels remove any doubt about orientation and flips.
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${Math.round(w / 22)}px system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      const pad = w / 28;
      ctx.fillText('TL', pad, pad);
      ctx.textAlign = 'right';
      ctx.fillText('TR', w - pad, pad);
      ctx.textBaseline = 'bottom';
      ctx.fillText('BR', w - pad, h - pad);
      ctx.textAlign = 'left';
      ctx.fillText('BL', pad, h - pad);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `bold ${Math.round(w / 26)}px system-ui, sans-serif`;
      ctx.fillText('CENTER', w / 2, h / 2 - w / 30);
      break;
    }
  }

  return c;
}

/** Rasterises a surface mask polygon (parametric space) into a canvas. */
export function renderMaskCanvas(mask, size = 512) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');

  const pts = mask.points || [];
  const hasShape = mask.enabled && pts.length >= 3;

  // Unmasked areas must be fully opaque white; masked areas black.
  ctx.fillStyle = hasShape ? (mask.invert ? '#fff' : '#000') : '#fff';
  ctx.fillRect(0, 0, size, size);

  if (hasShape) {
    const feather = Math.max(0, mask.feather || 0) * size;
    if (feather > 0.5) ctx.filter = `blur(${feather}px)`;
    ctx.fillStyle = mask.invert ? '#000' : '#fff';
    ctx.beginPath();
    ctx.moveTo(pts[0].x * size, pts[0].y * size);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x * size, pts[i].y * size);
    ctx.closePath();
    ctx.fill();
    ctx.filter = 'none';
  }

  return c;
}
