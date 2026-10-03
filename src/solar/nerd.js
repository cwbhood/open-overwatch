// "Under the hood" (key ` or the button in the layer panel): live frame timing, GPU work, what is loaded, and the
// accuracy of every position measured right here against NASA JPL Horizons, with the same code the tests use
// (core/accuracy.js on test/fixtures/horizons_2026-10-02.json).
import { fetchAsset } from '../core/assets.js';
import { measureAgainstHorizons } from '../core/accuracy.js';
import { esc } from '../core/format.js';
import { layer } from './world.js';

export function createNerd({ renderer, quality, small, exo, moons }) {
  const el = document.createElement('section'); el.id = 'nerd'; el.className = 'glass'; el.hidden = true; document.body.appendChild(el);
  const times = []; let last = 0, acc = null, accErr = '', timer = 0;
  const tick = t => { if (last) { times.push(t - last); if (times.length > 240) times.shift(); } last = t; };

  async function accuracy() {
    try {
      const [H, M] = await Promise.all([fetchAsset('test/fixtures/horizons_2026-10-02.json', 'json'), fetchAsset('data/solar/moons.json', 'json')]);
      const t0 = performance.now(); acc = { rows: measureAgainstHorizons(H, M.moons), ms: performance.now() - t0, source: H.source };
    } catch (e) { accErr = 'reference data unavailable: ' + e.message; }
    render();
  }
  const fmtAngle = d => d * 60 < 1 ? (d * 3600).toFixed(0) + '″' : d < 1 ? (d * 60).toFixed(1) + '′' : d.toFixed(2) + '°';
  function render() {
    const s = [...times].sort((a, b) => a - b), q = k => s.length ? s[Math.min(s.length - 1, Math.floor(k * s.length))] : 0;
    const fps = s.length ? 1000 / (times.reduce((a, b) => a + b, 0) / times.length) : 0, info = renderer.info.render, mem = performance.memory;
    const files = small.S.files.filter(Boolean), ast = files.reduce((n, f, i) => n + (f.points.visible ? f.view.N : 0), 0);
    el.innerHTML = `<button class="x" aria-label="Close">✕</button><div class="k">Under the hood</div>
      <h3>Rendering</h3><dl>
      <dt>Frame rate</dt><dd>${fps.toFixed(0)} fps · median ${q(0.5).toFixed(1)} ms · p95 ${q(0.95).toFixed(1)} ms</dd>
      <dt>Last frame</dt><dd>${info.calls} draw calls · ${(info.points / 1e6).toFixed(2)}M points · ${(info.triangles / 1e3).toFixed(0)}k triangles</dd>
      <dt>GPU</dt><dd>${esc(quality.gpu || 'hidden by the browser')}</dd>
      <dt>Graphics</dt><dd>${esc(quality.LEVELS[quality.level].name)}${quality.chosen === 'auto' ? ' (auto)' : ''} · pixel ratio ${renderer.getPixelRatio()}</dd>
      ${mem ? `<dt>JS heap</dt><dd>${(mem.usedJSHeapSize / 1e6).toFixed(0)} MB</dd>` : ''}</dl>
      <h3>In the scene</h3><dl>
      <dt>Asteroids</dt><dd>${ast.toLocaleString('en-US')} drawn (Kepler solved per point on the GPU, every frame)</dd>
      <dt>Stars</dt><dd>${(layer('stars').n || 0).toLocaleString('en-US')} (HYG)</dd>
      <dt>Moons</dt><dd>${moons.count ?? 20}</dd>
      <dt>Exoplanets</dt><dd>${exo.X.data ? `${exo.X.data.planets.toLocaleString('en-US')} in ${exo.X.data.systems.toLocaleString('en-US')} systems` : 'load when you head out to the stars'}</dd></dl>
      <h3>Accuracy vs NASA JPL, measured now</h3>
      ${acc ? `<table><tr><th></th><th>angle</th><th>position</th></tr>${acc.rows.map(r => `<tr><td>${esc(r.name)}</td><td>${fmtAngle(r.deg)}</td><td>${r.km < 1e5 ? Math.round(r.km).toLocaleString('en-US') + ' km' : (r.km / 1e6).toFixed(2) + 'M km'}</td></tr>`).join('')}</table>
        <p class="note">Our formulas against JPL Horizons vectors for 2026-10-02 (planets seen from the Sun, the Moon from Earth's centre, moons from their planet), computed in your browser in ${acc.ms.toFixed(1)} ms by the same code the automated tests run.</p>`
        : `<p class="note">${esc(accErr || 'measuring…')}</p>`}`;
    el.querySelector('.x').onclick = toggle;
  }
  function toggle() {
    el.hidden = !el.hidden;
    if (!el.hidden) { if (!acc && !accErr) accuracy(); render(); timer = setInterval(render, 500); } else clearInterval(timer);
  }
  addEventListener('keydown', e => { if (e.key === '`' && !/input|textarea/i.test(e.target.tagName)) toggle(); });
  return { tick, toggle, get open() { return !el.hidden; } };
}
