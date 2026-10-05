// On-screen navigation for desktops (phones get the dock in mobile.js): zoom in / out, a compass that shows where north
// is and snaps the view north-up and level, top-down, and "reset view" for when you are lost. Keys: + and - zoom,
// N north up, T top-down, R reset to the whole Earth. Zoom, north and top-down all work from wherever the camera is.
import { C, $, PHONE, toast } from './env.js';
import { camera, camHeight } from './viewer.js';
import { state, hooks } from './state.js';
import { Follow } from './follow.js';
import { PRESETS } from './ui.js';
import { LookUp } from './lookup.js';
import { Share } from './share.js';

const MAX_H = 5.9e8;   // the camera stops at 6e8 (viewer.js)

export function initNavpad() {
  if (PHONE) return;
  const pad = document.createElement('div'); pad.id = 'navpad'; pad.className = 'glass';
  pad.innerHTML = `<button data-n="in" title="Zoom in  (+)" aria-label="Zoom in">+</button>
    <button data-n="out" title="Zoom out  (−)" aria-label="Zoom out">−</button>
    <button data-n="north" id="npNorth" title="North up and level  (N)" aria-label="North up"><svg viewBox="0 0 24 24" id="npNeedle"><path d="M12 2 17 13H7z" fill="#ff6b5e"/><path d="M12 22 7 13h10z" fill="#8b9bab"/></svg></button>
    <button data-n="down" title="Look straight down  (T)" aria-label="Top-down view">⤓</button>
    <button data-n="share" title="Copy a link to this view" aria-label="Copy link to this view">⎘</button>
    <button data-n="embed" title="Copy code to put this view on your own web page" aria-label="Copy embed code">&lt;/&gt;</button>
    <button data-n="pic" title="Share a picture of this view  (P)" aria-label="Share a picture of this view">◫</button>
    <button data-n="reset" title="Reset view: the whole Earth  (R)" aria-label="Reset view">◎</button>`;
  document.body.append(pad);
  const needle = $('#npNeedle');

  let anim = 0;
  function zoom(factor) {   // factor < 1 zooms in. Eased over a quarter of a second.
    const h = camHeight();
    if (factor < 1 && h < 300) return;
    if (factor > 1 && h > MAX_H) return;
    // the change in height we want, then the distance to move along the view direction to get it (looking obliquely,
    // moving along the view changes the height only by sin(pitch) of it)
    const dh = factor < 1 ? Math.min(h * (1 - factor), h - 200) : Math.min(h * (factor - 1), 6.0e8 - h);
    const total = dh / Math.max(0.3, Math.abs(Math.sin(camera.pitch)));
    const t0 = performance.now(); let done = 0; cancelAnimationFrame(anim);
    const tick = now => {
      const u = Math.min(1, (now - t0) / 260), e = 1 - (1 - u) * (1 - u), step = total * e - done; done += step;
      factor < 1 ? camera.zoomIn(step) : camera.zoomOut(step);
      if (u < 1) anim = requestAnimationFrame(tick);
    };
    anim = requestAnimationFrame(tick);
  }
  function orient(heading, pitch, what) {
    if (state.lookingAtMoon || Follow.obj) { toast(`Stop following first (Esc), then ${what} works`); return; }
    camera.flyTo({ destination: camera.positionWC.clone(), orientation: { heading, pitch, roll: 0 }, duration: 0.8 });
  }
  const A = {
    in: () => zoom(0.55), out: () => zoom(1.8),
    north: () => orient(0, camera.pitch, 'north up'),
    down: () => orient(0, -Math.PI / 2, 'top-down'),
    reset: () => PRESETS.earth(),
    share: () => Share.copy(),
    pic: () => hooks.snapshot(),
    embed: () => Share.copyEmbed(),
  };
  pad.addEventListener('click', e => { const b = e.target.closest('[data-n]'); if (b) A[b.dataset.n](); });
  pad.addEventListener('pointerdown', e => e.stopPropagation());   // the buttons never start a globe drag

  addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey || LookUp.active || /input|textarea|select/i.test(e.target.tagName)) return;
    const k = e.key.toLowerCase();
    if (k === '+' || k === '=') A.in(); else if (k === '-' || k === '_') A.out(); else if (k === 'n') A.north(); else if (k === 't') A.down(); else if (k === 'r') A.reset(); else if (k === 'p') A.pic(); else if (e.key === '/') { e.preventDefault(); PRESETS.search(); }
  });

  // the needle points to north: it turns against the camera heading, so a skewed view is obvious at a glance
  let last = NaN;
  setInterval(() => {
    const h = C.Math.toDegrees(camera.heading) || 0; if (Math.abs(h - last) < 0.5) return; last = h;
    needle.style.transform = `rotate(${-h}deg)`;
    $('#npNorth').classList.toggle('askew', Math.min(h, 360 - h) > 1);
  }, 200);
}
