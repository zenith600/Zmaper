'use strict';

import { BLEND_MODES, resampleMesh, convertSurfaceType } from '../core/state.js';
import { resetSurfaceShape, rotateSurface, scaleSurface } from '../core/surfaceGeom.js';

// ---------------------------------------------------------------------------
// Small declarative DOM helpers
// ---------------------------------------------------------------------------

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) {
    if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function group(title, children, open = true) {
  const body = el('div', { class: 'group-body' }, children);
  return el('details', { class: 'group', ...(open ? { open: true } : {}) }, [
    el('summary', { text: title }),
    body
  ]);
}

function field(label, control) {
  return el('div', { class: 'field' }, [
    el('label', { text: label }),
    el('div', { class: 'ctl' }, [].concat(control))
  ]);
}

/** Slider + live numeric readout, wired to a getter/setter pair. */
function slider({ min, max, step, value, format, onInput }) {
  const out = el('span', { class: 'num', text: format(value) });
  const input = el('input', { type: 'range', min, max, step, value });
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    out.textContent = format(v);
    onInput(v);
  });
  return [input, out];
}

function numberInput({ value, min, max, step, onChange, width }) {
  const input = el('input', { type: 'number', value, min, max, step });
  if (width) input.style.flex = `0 0 ${width}`;
  const commit = () => {
    const v = parseFloat(input.value);
    if (Number.isFinite(v)) onChange(v);
  };
  input.addEventListener('change', commit);
  return input;
}

function segmented(options, current, onPick) {
  const wrap = el('div', { class: 'seg' });
  for (const opt of options) {
    wrap.appendChild(
      el('button', {
        class: opt.value === current ? 'active' : '',
        text: opt.label,
        onClick: () => onPick(opt.value)
      })
    );
  }
  return wrap;
}

const pct = (v) => `${Math.round(v * 100)}%`;
const fixed2 = (v) => v.toFixed(2);

function rgbToHex([r, g, b]) {
  const h = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [1, 1, 1];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

/**
 * Rebuilds the right-hand panel for the current selection.
 * `app` supplies: project, selectedSurface(), commit(), refreshLists(),
 * pushUndo(), rebuildInspector(), toast().
 */
export function renderInspector(container, app) {
  container.innerHTML = '';
  const surface = app.selectedSurface();

  if (!surface) {
    container.appendChild(outputGroup(app));
    container.appendChild(
      el('p', { class: 'empty' }, [
        'No surface selected.',
        el('br'),
        el('br'),
        'Add a Quad for flat panels and screens, or a Mesh for curved and irregular objects.'
      ])
    );
    return;
  }

  container.appendChild(surfaceGroup(surface, app));
  container.appendChild(geometryGroup(surface, app));
  container.appendChild(sourceGroup(surface, app));
  container.appendChild(lookGroup(surface, app));
  container.appendChild(edgeGroup(surface, app));
  container.appendChild(maskGroup(surface, app));
  container.appendChild(outputGroup(app, false));
}

// -- Surface -----------------------------------------------------------------

function surfaceGroup(s, app) {
  const nameInput = el('input', { type: 'text', value: s.name });
  nameInput.addEventListener('input', () => {
    s.name = nameInput.value;
    app.refreshLists();
    app.commit();
  });

  const flags = el('div', { class: 'btn-row' }, [
    toggleBtn('Visible', s.visible, (v) => {
      s.visible = v;
      app.refreshLists();
      app.commit();
    }),
    toggleBtn('Solo', s.solo, (v) => {
      s.solo = v;
      app.refreshLists();
      app.commit();
    }),
    toggleBtn('Locked', s.locked, (v) => {
      s.locked = v;
      app.refreshLists();
      app.commit();
    })
  ]);

  return group('Surface', [
    field('Name', nameInput),
    field(
      'Type',
      segmented(
        [
          { value: 'quad', label: 'Quad' },
          { value: 'mesh', label: 'Mesh' }
        ],
        s.type,
        (type) => {
          if (type === s.type) return;
          app.pushUndo();
          convertSurfaceType(s, type);
          app.rebuildInspector();
          app.refreshLists();
          app.commit();
        }
      )
    ),
    flags,
    el('div', { class: 'btn-row' }, [
      el('button', {
        class: 'btn',
        text: 'Duplicate',
        onClick: () => app.duplicateSurface(s.id)
      }),
      el('button', {
        class: 'btn danger',
        text: 'Delete',
        onClick: () => app.deleteSurface(s.id)
      })
    ])
  ]);
}

function toggleBtn(label, on, onToggle) {
  const b = el('button', { class: `btn${on ? ' tool active' : ''}`, text: label });
  b.addEventListener('click', () => {
    on = !on;
    b.className = `btn${on ? ' tool active' : ''}`;
    onToggle(on);
  });
  return b;
}

// -- Geometry ----------------------------------------------------------------

function geometryGroup(s, app) {
  const children = [];

  if (s.type === 'mesh') {
    const colsIn = numberInput({
      value: s.cols,
      min: 1,
      max: 24,
      step: 1,
      onChange: (v) => {
        app.pushUndo();
        resampleMesh(s, Math.round(Math.max(1, Math.min(24, v))), s.rows);
        app.commit();
      }
    });
    const rowsIn = numberInput({
      value: s.rows,
      min: 1,
      max: 24,
      step: 1,
      onChange: (v) => {
        app.pushUndo();
        resampleMesh(s, s.cols, Math.round(Math.max(1, Math.min(24, v))));
        app.commit();
      }
    });

    children.push(
      field('Grid', [el('div', { class: 'grid-2' }, [colsIn, rowsIn])]),
      field(
        'Curve',
        segmented(
          [
            { value: 'smooth', label: 'Smooth' },
            { value: 'linear', label: 'Linear' }
          ],
          s.interpolation,
          (v) => {
            s.interpolation = v;
            app.commit();
          }
        )
      ),
      el('p', { class: 'hint', text: 'Smooth uses Catmull-Rom patches - right for curved walls, columns and domes. Linear keeps cell edges straight.' })
    );
  } else {
    children.push(
      el('p', { class: 'hint', text: 'Drag the four corners on the canvas. Texturing stays perspective-correct as you keystone.' })
    );
  }

  children.push(
    el('div', { class: 'btn-row' }, [
      el('button', {
        class: 'btn',
        text: 'Reset shape',
        onClick: () => {
          app.pushUndo();
          resetSurfaceShape(s);
          app.commit();
        }
      }),
      el('button', {
        class: 'btn',
        text: 'Rotate 90',
        onClick: () => {
          app.pushUndo();
          rotateSurface(s, 90, app.aspect());
          app.commit();
        }
      })
    ]),
    el('div', { class: 'btn-row' }, [
      el('button', {
        class: 'btn',
        text: 'Scale -',
        onClick: () => {
          app.pushUndo();
          scaleSurface(s, 1 / 1.1);
          app.commit();
        }
      }),
      el('button', {
        class: 'btn',
        text: 'Scale +',
        onClick: () => {
          app.pushUndo();
          scaleSurface(s, 1.1);
          app.commit();
        }
      }),
      el('button', {
        class: 'btn',
        text: 'Fill output',
        onClick: () => {
          app.pushUndo();
          app.fillOutput(s);
          app.commit();
        }
      })
    ])
  );

  return group('Geometry', children);
}

// -- Source ------------------------------------------------------------------

function sourceGroup(s, app) {
  const select = el('select');
  select.appendChild(el('option', { value: '', text: '- none -' }));
  for (const m of app.project.media) {
    const opt = el('option', { value: m.id, text: `${m.name}  (${m.kind})` });
    if (m.id === s.mediaId) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    s.mediaId = select.value || null;
    app.refreshLists();
    app.commit();
  });

  const mediaDef = app.project.media.find((m) => m.id === s.mediaId) || null;

  const inp = s.input;
  const mk = (key, label) =>
    field(label, [
      numberInput({
        value: +inp[key].toFixed(4),
        min: -2,
        max: 3,
        step: 0.01,
        onChange: (v) => {
          inp[key] = v;
          app.commit();
        }
      })
    ]);

  const flipRow = el('div', { class: 'btn-row' }, [
    toggleBtn('Flip H', inp.flipH, (v) => {
      inp.flipH = v;
      app.commit();
    }),
    toggleBtn('Flip V', inp.flipV, (v) => {
      inp.flipV = v;
      app.commit();
    })
  ]);

  return group('Source', [
    field('Media', select),
    ...(mediaDef && mediaDef.kind === 'webcam' ? cameraFields(mediaDef, app) : []),
    el('div', { class: 'grid-2' }, [mk('x', 'Crop X'), mk('y', 'Crop Y')]),
    el('div', { class: 'grid-2' }, [mk('w', 'Crop W'), mk('h', 'Crop H')]),
    field(
      'Rotate',
      slider({
        min: -180,
        max: 180,
        step: 1,
        value: inp.rotate,
        format: (v) => `${Math.round(v)}°`,
        onInput: (v) => {
          inp.rotate = v;
          app.commit();
        }
      })
    ),
    flipRow,
    el('div', { class: 'btn-row' }, [
      el('button', {
        class: 'btn',
        text: 'Reset crop',
        onClick: () => {
          app.pushUndo();
          Object.assign(inp, { x: 0, y: 0, w: 1, h: 1, rotate: 0 });
          app.rebuildInspector();
          app.commit();
        }
      }),
      el('button', {
        class: 'btn',
        text: 'Fit aspect',
        onClick: () => {
          app.pushUndo();
          app.fitSourceAspect(s);
          app.rebuildInspector();
          app.commit();
        }
      })
    ]),
    el('p', { class: 'hint', text: 'Press I, or use the Source tool, to drag the crop directly on the media.' })
  ]);
}

/**
 * Camera chooser, shown only when the surface's source is a webcam.
 * Switching deviceId changes the media's signature, so the pool tears the old
 * stream down and opens the new device - in the editor and on the projector.
 */
function cameraFields(media, app) {
  const cameras = app.cameras || [];

  const select = el('select');
  select.appendChild(el('option', { value: '', text: 'System default' }));
  for (const c of cameras) {
    if (!c.deviceId) continue;
    const opt = el('option', { value: c.deviceId, text: c.label });
    if (c.deviceId === media.deviceId) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    app.pushUndo();
    media.deviceId = select.value || null;
    const cam = cameras.find((c) => c.deviceId === select.value);
    media.name = cam ? cam.label : 'Webcam';
    app.refreshLists();
    app.rebuildInspector();
    app.commit();
  });

  const rescan = el('button', {
    class: 'btn',
    text: 'Rescan',
    title: 'Look for cameras plugged in since the app started',
    onClick: async () => {
      const found = (await app.refreshCameras()) || [];
      app.refreshLists();
      app.rebuildInspector();
      app.toast(`${found.length} camera${found.length === 1 ? '' : 's'} found`);
    }
  });
  rescan.style.flex = '0 0 auto';

  const usable = cameras.filter((c) => c.deviceId).length;
  const out = [field('Camera', [select, rescan])];

  if (!usable) {
    out.push(
      el('p', {
        class: 'hint',
        text: cameras.length
          ? 'Camera names appear once you allow camera access. Press Rescan after granting it.'
          : 'No cameras detected. Plug one in and press Rescan.'
      })
    );
  }
  return out;
}

// -- Look --------------------------------------------------------------------

function lookGroup(s, app) {
  const blendSelect = el('select');
  for (const b of BLEND_MODES) {
    const opt = el('option', { value: b, text: b[0].toUpperCase() + b.slice(1) });
    if (b === s.blend) opt.selected = true;
    blendSelect.appendChild(opt);
  }
  blendSelect.addEventListener('change', () => {
    s.blend = blendSelect.value;
    app.commit();
  });

  const tint = el('input', { type: 'color', value: rgbToHex(s.tint) });
  tint.addEventListener('input', () => {
    s.tint = hexToRgb(tint.value);
    app.commit();
  });

  const sl = (key, label, min, max, step, format) =>
    field(
      label,
      slider({
        min,
        max,
        step,
        value: s[key],
        format,
        onInput: (v) => {
          s[key] = v;
          app.commit();
        }
      })
    );

  return group('Look', [
    sl('opacity', 'Opacity', 0, 1, 0.01, pct),
    field('Blend', blendSelect),
    field('Tint', [tint, el('span', { class: 'num', text: '' })]),
    sl('brightness', 'Brightness', 0, 2, 0.01, fixed2),
    sl('contrast', 'Contrast', 0, 3, 0.01, fixed2),
    sl('saturation', 'Saturation', 0, 3, 0.01, fixed2),
    sl('gamma', 'Gamma', 0.2, 3, 0.01, fixed2)
  ]);
}

// -- Edge blend --------------------------------------------------------------

function edgeGroup(s, app) {
  const e = s.edge;
  const sl = (key, label, max, format) =>
    field(
      label,
      slider({
        min: 0,
        max,
        step: 0.005,
        value: e[key],
        format,
        onInput: (v) => {
          e[key] = v;
          app.commit();
        }
      })
    );

  return group(
    'Edge blend',
    [
      sl('left', 'Left', 0.5, pct),
      sl('right', 'Right', 0.5, pct),
      sl('top', 'Top', 0.5, pct),
      sl('bottom', 'Bottom', 0.5, pct),
      field(
        'Blend gamma',
        slider({
          min: 1,
          max: 4,
          step: 0.05,
          value: e.gamma,
          format: fixed2,
          onInput: (v) => {
            e.gamma = v;
            app.commit();
          }
        })
      ),
      field(
        'Curve',
        slider({
          min: 0.2,
          max: 3,
          step: 0.05,
          value: e.curve,
          format: fixed2,
          onInput: (v) => {
            e.curve = v;
            app.commit();
          }
        })
      ),
      el('div', { class: 'btn-row' }, [
        el('button', {
          class: 'btn',
          text: 'Clear',
          onClick: () => {
            app.pushUndo();
            Object.assign(e, { left: 0, right: 0, top: 0, bottom: 0 });
            app.rebuildInspector();
            app.commit();
          }
        })
      ]),
      el('p', {
        class: 'hint',
        text: 'Feather the edge that overlaps the neighbouring projector on both surfaces. Raise blend gamma until the overlap stops reading as a bright or dark band.'
      })
    ],
    false
  );
}

// -- Mask --------------------------------------------------------------------

function maskGroup(s, app) {
  const m = s.mask;
  const count = (m.points || []).length;

  return group(
    'Mask',
    [
      el('div', { class: 'btn-row' }, [
        toggleBtn('Enabled', m.enabled, (v) => {
          m.enabled = v;
          app.commit();
        }),
        toggleBtn('Invert', m.invert, (v) => {
          m.invert = v;
          app.commit();
        })
      ]),
      field(
        'Feather',
        slider({
          min: 0,
          max: 0.25,
          step: 0.002,
          value: m.feather,
          format: pct,
          onInput: (v) => {
            m.feather = v;
            app.commit();
          }
        })
      ),
      el('p', { class: 'hint', text: `${count} point${count === 1 ? '' : 's'}. Press K, click to add points, drag to move them, right-click a point to remove it.` }),
      el('div', { class: 'btn-row' }, [
        el('button', {
          class: 'btn',
          text: 'Rect',
          onClick: () => {
            app.pushUndo();
            m.points = [
              { x: 0.15, y: 0.15 },
              { x: 0.85, y: 0.15 },
              { x: 0.85, y: 0.85 },
              { x: 0.15, y: 0.85 }
            ];
            m.enabled = true;
            app.rebuildInspector();
            app.commit();
          }
        }),
        el('button', {
          class: 'btn',
          text: 'Ellipse',
          onClick: () => {
            app.pushUndo();
            const pts = [];
            for (let i = 0; i < 24; i++) {
              const a = (i / 24) * Math.PI * 2;
              pts.push({ x: 0.5 + Math.cos(a) * 0.4, y: 0.5 + Math.sin(a) * 0.4 });
            }
            m.points = pts;
            m.enabled = true;
            app.rebuildInspector();
            app.commit();
          }
        }),
        el('button', {
          class: 'btn danger',
          text: 'Clear',
          onClick: () => {
            app.pushUndo();
            m.points = [];
            app.rebuildInspector();
            app.commit();
          }
        })
      ])
    ],
    count > 0
  );
}

// -- Output ------------------------------------------------------------------

function outputGroup(app, open = true) {
  const o = app.project.output;

  const wIn = numberInput({
    value: o.width,
    min: 320,
    max: 16384,
    step: 1,
    onChange: (v) => app.setOutputSize(Math.round(v), o.height)
  });
  const hIn = numberInput({
    value: o.height,
    min: 240,
    max: 16384,
    step: 1,
    onChange: (v) => app.setOutputSize(o.width, Math.round(v))
  });

  const presets = el('select');
  presets.appendChild(el('option', { value: '', text: 'Presets...' }));
  for (const [label, w, h] of [
    ['1280 x 720', 1280, 720],
    ['1920 x 1080', 1920, 1080],
    ['1920 x 1200', 1920, 1200],
    ['2560 x 1440', 2560, 1440],
    ['3840 x 1080  (2 x HD wide)', 3840, 1080],
    ['3840 x 2160  (4K)', 3840, 2160],
    ['1024 x 768', 1024, 768],
    ['Match output display', 0, 0]
  ]) {
    presets.appendChild(el('option', { value: `${w}x${h}`, text: label }));
  }
  presets.addEventListener('change', () => {
    const [w, h] = presets.value.split('x').map(Number);
    if (w === 0) app.matchDisplayResolution();
    else if (w) app.setOutputSize(w, h);
    presets.value = '';
    app.rebuildInspector();
  });

  const bg = el('input', { type: 'color', value: rgbToHex(o.backgroundColor) });
  bg.addEventListener('input', () => {
    o.backgroundColor = hexToRgb(bg.value);
    app.commit();
  });

  return group(
    'Output',
    [
      field('Size', [el('div', { class: 'grid-2' }, [wIn, hIn])]),
      field('Preset', presets),
      field(
        'Master',
        slider({
          min: 0,
          max: 1,
          step: 0.01,
          value: o.brightness,
          format: pct,
          onInput: (v) => {
            o.brightness = v;
            app.commit();
          }
        })
      ),
      field('Background', [bg, el('span', { class: 'num', text: '' })])
    ],
    open
  );
}
