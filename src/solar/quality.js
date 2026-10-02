// Graphics quality for the Solar System view, same scheme as the globe (src/globe/quality.js): phones start on "low",
// other devices on "high"; in "auto", two slow 3 s windows in a row (median frame over 40 ms) step down one level.
// The costs here are on the GPU: pixels (the log depth buffer writes gl_FragDepth, which turns off early depth tests)
// and the 1.57M asteroids whose orbits are solved per point per frame in the vertex shader.
import { PHONE } from './util.js';
import { rendererName, isSoftwareRenderer } from '../core/gpu.js';

export const LEVELS = {
  high: { name: 'High', pixelRatio: 2, allAsteroids: true },
  balanced: { name: 'Balanced', pixelRatio: 1.25, allAsteroids: true },
  low: { name: 'Low', pixelRatio: 1, allAsteroids: false },     // the brightest 300k asteroids only
};
const ORDER = ['high', 'balanced', 'low'];
const KEY = 'ooss.quality';
const read = () => { try { return localStorage.getItem(KEY) || 'auto'; } catch (e) { return 'auto'; } };

export function createQuality({ renderer, small, onAutoChange = () => {} }) {
  const Q = {
    LEVELS, chosen: read(), level: null, gpu: rendererName(renderer.getContext()),
    get software() { return isSoftwareRenderer(Q.gpu); },
    get autoLevel() { return PHONE || Q.software ? 'low' : 'high'; },
    apply(id) {
      Q.level = id; const q = LEVELS[id];
      renderer.setPixelRatio(Math.min(devicePixelRatio, q.pixelRatio)); renderer.setSize(innerWidth, innerHeight);
      small.setFull(q.allAsteroids);
    },
    choose(id) { Q.chosen = id; try { localStorage.setItem(KEY, id); } catch (e) { /* private mode */ } Q.apply(id === 'auto' ? Q.autoLevel : id); },
    // fed by the render loop with each frame's timestamp
    tick(t) {
      if (Q.chosen !== 'auto' || t < startAt) { last = 0; return; }
      if (last) times.push(t - last);
      last = t; if (!windowStart) windowStart = t;
      if (t - windowStart < 3000) return;
      times.sort((a, b) => a - b);
      const median = times[times.length >> 1] || 0; times = []; windowStart = t;
      slow = median > 40 ? slow + 1 : 0;
      const i = ORDER.indexOf(Q.level);
      if (slow >= 2 && i < ORDER.length - 1) { slow = 0; Q.apply(ORDER[i + 1]); onAutoChange(LEVELS[Q.level]); }
    },
    resetTiming() { last = 0; times = []; windowStart = 0; },
  };
  let times = [], last = 0, windowStart = 0, slow = 0;
  const startAt = performance.now() + 10e3;
  addEventListener('visibilitychange', Q.resetTiming);
  Q.apply(Q.chosen === 'auto' ? Q.autoLevel : Q.chosen);
  return Q;
}
