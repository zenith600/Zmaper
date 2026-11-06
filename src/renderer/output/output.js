'use strict';

import { Renderer } from '../core/renderer.js';

const canvas = document.getElementById('stage');
const hint = document.getElementById('hint');

let renderer;
try {
  renderer = new Renderer(canvas);
} catch (err) {
  hint.textContent = err.message;
  throw err;
}

let project = null;
let frames = 0;
let lastReport = performance.now();

function fitCanvas() {
  const dpr = window.devicePixelRatio || 1;
  renderer.resize(Math.round(window.innerWidth * dpr), Math.round(window.innerHeight * dpr));
}
fitCanvas();
window.addEventListener('resize', fitCanvas);

window.zmaper.on('sync', (msg) => {
  if (!msg) return;

  switch (msg.type) {
    case 'project':
      project = msg.payload;
      renderer.setProject(project);
      hint.classList.add('hidden');
      break;

    case 'transport':
      if (msg.action === 'play') renderer.media.play(msg.mediaId);
      else if (msg.action === 'pause') renderer.media.pause(msg.mediaId);
      else if (msg.action === 'seek') renderer.media.seek(msg.mediaId, msg.time);
      break;

  }
});

function frame() {
  if (project) renderer.render();

  frames++;
  const now = performance.now();
  if (now - lastReport > 1000) {
    window.zmaper.report({ fps: Math.round((frames * 1000) / (now - lastReport)) });
    frames = 0;
    lastReport = now;
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Report media that failed to load or decode, so a silent black surface on the
// projector shows up as a visible error in the editor's media list.
let lastErrors = '';
setInterval(() => {
  const errors = renderer.media.errors();
  const signature = JSON.stringify(errors);
  if (signature === lastErrors) return;
  lastErrors = signature;
  window.zmaper.report({ mediaErrors: errors });
}, 1000);

/**
 * Tell the editor we are live so it pushes the current project.
 *
 * Deliberately waits until the window is actually on screen: this window is
 * created hidden, and media elements built while it is hidden can have their
 * playback refused.
 */
function announceReady() {
  window.zmaper.report({ ready: true });
}

if (document.visibilityState === 'visible') {
  announceReady();
} else {
  const onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    document.removeEventListener('visibilitychange', onVisible);
    announceReady();
  };
  document.addEventListener('visibilitychange', onVisible);
  // Never leave the output blank if the visibility event does not arrive.
  setTimeout(() => {
    document.removeEventListener('visibilitychange', onVisible);
    announceReady();
  }, 1500);
}
