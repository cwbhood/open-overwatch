// "Under the hood" for the globe (key ` or Layers → Under the hood): frame timing, the GPU, the satellite worker, where
// every feed came from and how old it is, and how far to trust each kind of position.
import { esc, fmt } from './env.js';
import { scene, globe } from './viewer.js';
import { Sats } from './satellites.js';
import { Air } from './aircraft.js';
import { Quality, LEVELS } from './quality.js';
import { Eclipses } from './eclipses.js';
import { tleEpochJd } from '../core/tle.js';
import { jdFromMs } from '../core/time.js';

const el = document.createElement('section'); el.id = 'nerd'; el.className = 'glass'; el.hidden = true; document.body.appendChild(el);
const times = []; let last = 0, timer = 0, tleAge = null;
scene.postRender.addEventListener(() => { const t = performance.now(); if (last) { times.push(t - last); if (times.length > 240) times.shift(); } last = t; });
const ago = ms => ms == null ? '—' : ms < 5e3 ? 'just now' : ms < 90e3 ? Math.round(ms / 1000) + ' s' : ms < 5400e3 ? Math.round(ms / 60e3) + ' min' : (ms / 3600e3).toFixed(1) + ' h';
const SOURCE = { mirror: 'site copy of CelesTrak', celestrak: 'CelesTrak', cache: 'browser cache', 'stale cache': 'old cache' };

function render() {
  const s = [...times].sort((a, b) => a - b), q = k => s.length ? s[Math.min(s.length - 1, Math.floor(k * s.length))] : 0;
  const fps = times.length ? 1000 / (times.reduce((a, b) => a + b, 0) / times.length) : 0, mem = performance.memory;
  if (tleAge == null && Sats.list.length) {   // median age of the element sets (SGP4 error grows with it)
    const now = jdFromMs(Date.now()), ages = Sats.list.map(x => now - tleEpochJd(x.l1)).filter(Number.isFinite).sort((a, b) => a - b);
    tleAge = ages[ages.length >> 1];
  }
  const ecl = Eclipses.state.list?.find(e => e.date === '2027-08-02' && e.greatest);
  const groups = Object.entries(Sats.sources).map(([g, v]) => `<tr><td>${esc(g)}</td><td>${esc(SOURCE[v.source] || v.source || '—')}</td><td>${ago(v.ageMs)}</td></tr>`).join('');
  el.innerHTML = `<button class="x" aria-label="Close">×</button><div class="k">Under the hood</div>
    <h3>Rendering</h3><dl><dt>Frame rate</dt><dd>${fps.toFixed(0)} fps · median ${q(0.5).toFixed(1)} ms · p95 ${q(0.95).toFixed(1)} ms</dd>
    <dt>GPU</dt><dd>${esc(Quality.gpu || 'hidden by the browser')}</dd><dt>Graphics</dt><dd>${esc(LEVELS[Quality.level].name)}${Quality.chosen === 'auto' ? ' (auto)' : ''} · tile detail ${globe.maximumScreenSpaceError}</dd>
    <dt>Map tiles</dt><dd>${globe.tilesLoaded ? 'all loaded' : 'loading…'}</dd>${mem ? `<dt>JS heap</dt><dd>${(mem.usedJSHeapSize / 1e6).toFixed(0)} MB</dd>` : ''}</dl>
    <h3>Satellites</h3><dl><dt>Propagated</dt><dd>${fmt(Sats.list.length)} with SGP4 in a web worker · ${Sats.tickMs ? Sats.tickMs.toFixed(0) + ' ms per pass' : '—'}</dd>
    <dt>Element sets</dt><dd>median ${tleAge != null ? (tleAge * 24).toFixed(0) + ' h' : '—'} old</dd></dl>
    <table><tr><th>group</th><th>from</th><th>age</th></tr>${groups}</table>
    <h3>Aircraft</h3><dl><dt>Tracked</dt><dd>${fmt(Air.map.size)}</dd><dt>OpenSky snapshot</dt><dd>${Air.snapshotAt ? ago(Date.now() - Air.snapshotAt) + ' old' : '—'}</dd><dt>Military feed</dt><dd>${Air.milAt ? ago(Date.now() - Air.milAt) + ' old' : '—'}</dd></dl>
    <h3>How far to trust it</h3><dl>
    <dt>Satellites</dt><dd>SGP4 from public element sets: ~1 km at their epoch, growing 1–3 km a day</dd>
    <dt>Aircraft</dt><dd>last reported fix, dead-reckoned for up to 15 min</dd>
    <dt>Earth's rotation</dt><dd>IAU 2006 precession-nutation (Cesium); the Solar System hand-over is in ICRF</dd>
    <dt>Eclipses</dt><dd>${ecl ? '2 Aug 2027, computed here: greatest eclipse within ~0.1° of NASA\'s point, totality within ~5 s' : 'Sun and Moon from JPL Horizons every minute (open Eclipses)'}</dd></dl>
    <p class="note">Press the \` key to close. The Solar System view has the same panel, with its errors measured live against NASA JPL.</p>`;
  el.querySelector('.x').onclick = toggle;
}
export function toggle() { el.hidden = !el.hidden; if (!el.hidden) { render(); timer = setInterval(render, 500); } else clearInterval(timer); }
addEventListener('keydown', e => { if (e.key === '`' && !/input|textarea/i.test(e.target.tagName)) toggle(); });
