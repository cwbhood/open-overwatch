// Graphics quality: three levels, chosen per device and stepped down automatically when frames run slow.
// Phones start on "low" (the GPU is the limit there and emulation can't measure it); everything else starts on "high".
// While the page is visible, the median frame time of each 3 s window is watched: two slow windows in a row (median
// over 40 ms, i.e. under 25 fps) step the level down once. The median ignores one-off shader-compile stalls. A level the
// user picks in the dock is kept (localStorage) and never changed automatically.
import { PHONE, store, toast } from './env.js';
import { viewer, scene, globe } from './viewer.js';
import { rendererName, isSoftwareRenderer, SOFTWARE_HINT } from '../core/gpu.js';

export const LEVELS = {
  high: { name: 'High', sse: 2, air: 200, sat: 40, octaves: 4, fps: 0 },
  balanced: { name: 'Balanced', sse: 3, air: 80, sat: 25, octaves: 2, fps: 0 },
  low: { name: 'Low', sse: 4, air: 30, sat: 12, octaves: 1, fps: 30 },
};
const ORDER = ['high', 'balanced', 'low'];

export const Quality = {
  chosen: store.get('quality', 'auto'),          // 'auto' or a level id
  level: null, targets: [],
  /** Things that follow the level: fn(levelSettings) is called now and on every change. */
  follow(fn) { this.targets.push(fn); if (this.level) fn(LEVELS[this.level]); },
  apply(id) {
    this.level = id; const q = LEVELS[id];
    globe.maximumScreenSpaceError = q.sse;
    viewer.targetFrameRate = q.fps || undefined;   // 30 fps on low: half the GPU work, cooler phones, steadier frames
    for (const fn of this.targets) fn(q);
  },
  gpu: rendererName(scene.context._gl),
  get autoLevel() { return PHONE || isSoftwareRenderer(this.gpu) ? 'low' : 'high'; },
  choose(id) { this.chosen = id; store.set('quality', id); this.apply(id === 'auto' ? this.autoLevel : id); },
};
Quality.apply(Quality.chosen === 'auto' ? Quality.autoLevel : Quality.chosen);
if (isSoftwareRenderer(Quality.gpu)) setTimeout(() => toast(SOFTWARE_HINT, 15000), 4000);

// ---- the automatic step-down
{
  let times = [], last = 0, windowStart = 0, slow = 0;
  const startAt = performance.now() + 12e3;        // let the boot and the first tile burst pass
  scene.postRender.addEventListener(() => {
    const t = performance.now();
    if (document.hidden || t < startAt || Quality.chosen !== 'auto') { last = 0; return; }
    if (last) times.push(t - last);
    last = t;
    if (!windowStart) windowStart = t;
    if (t - windowStart < 3000) return;
    times.sort((a, b) => a - b);
    const median = times[times.length >> 1] || 0; times = []; windowStart = t;
    const budget = LEVELS[Quality.level].fps ? 1000 / LEVELS[Quality.level].fps + 8 : 40;
    slow = median > Math.max(40, budget) ? slow + 1 : 0;
    const i = ORDER.indexOf(Quality.level);
    if (slow >= 2 && i < ORDER.length - 1) {
      slow = 0; Quality.apply(ORDER[i + 1]);
      toast(`Graphics set to ${LEVELS[Quality.level].name} for smoother motion (change it in Layers)`, 4000);
    }
  });
  addEventListener('visibilitychange', () => { last = 0; times = []; windowStart = 0; });
}
