// perf.mjs — load numbers and frame rate for each page, desktop and phone-emulated, in headless Edge on the GPU.
//   node perf.mjs [desktop|phone|both] [page ...]       pages default to globe.html solar.html open-overwatch.html
// Phone = 390x844 @3x, mobile + touch, CPU throttled 4x (a mid-range phone; the GPU can't be throttled, so phone
// numbers are optimistic on graphics). Writes brand/perf/<date>.json and prints a table. Needs serve.js on :8787.
// The live feeds that must never see automated traffic are blocked, as in globe_shot.mjs.
import { launch, sleep } from './cdp.mjs';
import { writeFile, mkdir } from 'node:fs/promises';

const [modeArg = 'both', ...pageArgs] = process.argv.slice(2);
const PAGES = pageArgs.length ? pageArgs : ['globe.html', 'solar.html', 'open-overwatch.html'];
const MODES = modeArg === 'both' ? ['desktop', 'phone'] : [modeArg];
const BASE = process.env.OO_BASE || 'http://localhost:8787/';
const SETTLE_S = +(process.env.OO_SETTLE || 15), SAMPLE_S = +(process.env.OO_SAMPLE || 8);
const PROFILES = {
  desktop: { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false, cpu: 1 },
  phone: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, cpu: 4,
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36' },
};
// per page: what to do once loaded (the 2D map has a boot screen)
const START = { 'open-overwatch.html': `[...document.querySelectorAll('button')].find(b => /silent/i.test(b.textContent))?.click()` };

// per page: camera motion for the second sample (moving is where lag shows: tiles, labels, picking)
const MOTION = {
  'globe.html': `OO3D.PRESETS.ground()`,                                   // 3 s flight from orbit to a London street
  'solar.html': `OOSS.nav.flyDist(2e9, 8)`,                                // Earth out through the asteroid belt to the stars
  'open-overwatch.html': `{ let k = 0; const id = setInterval(() => { OW.map.panBy([30, 8], { animate: false }); if (++k > 500) clearInterval(id); }, 16); }`,
};
const sample = (p, s) => p.eval(`new Promise(res => { const d = []; let last = performance.now(), end = last + ${s * 1000};
  const f = t => { d.push(t - last); last = t; if (t < end) requestAnimationFrame(f); else res(d); }; requestAnimationFrame(f); })`, { timeoutMs: (s + 30) * 1000 });
const stats = (frames, s) => { const v = [...frames].sort((a, b) => a - b), q = k => v[Math.min(v.length - 1, Math.floor(k * v.length))];
  return { fps: +(frames.length / s).toFixed(1), medianMs: +q(0.5).toFixed(1), p95Ms: +q(0.95).toFixed(1), maxMs: +v[v.length - 1].toFixed(0) }; };
const results = [];
for (const mode of MODES) {
  const P = PROFILES[mode];
  const b = await launch({ windowSize: [P.width, P.height], args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-unsafe-swiftshader'] });
  try {
    for (const page of PAGES) {
      const p = await b.newPage();
      await p.send('Page.enable'); await p.send('Runtime.enable'); await p.send('Network.enable'); await p.send('Performance.enable');
      await p.send('Network.setBlockedURLs', { urls: ['*celestrak.org*', '*opensky-network.org*', '*adsb.lol*', '*adsb.fi*', '*airplanes.live*', '*earthquake.usgs.gov*', '*wheretheiss.at*'] });
      await p.send('Network.setCacheDisabled', { cacheDisabled: true });
      await p.send('Emulation.setDeviceMetricsOverride', { width: P.width, height: P.height, deviceScaleFactor: P.deviceScaleFactor, mobile: P.mobile });
      if (P.mobile) { await p.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }); await p.send('Emulation.setUserAgentOverride', { userAgent: P.ua }); }
      await p.send('Emulation.setCPUThrottlingRate', { rate: P.cpu });
      let bytes = 0, requests = 0, failed = 0; const big = [];
      const urls = new Map();
      p.on('Network.requestWillBeSent', e => urls.set(e.requestId, e.request.url));
      p.on('Network.loadingFinished', e => { bytes += e.encodedDataLength; requests++; if (e.encodedDataLength > 1e6) big.push([urls.get(e.requestId), e.encodedDataLength]); });
      p.on('Network.loadingFailed', () => failed++);
      const t0 = Date.now(), loaded = p.waitFor('Page.loadEventFired', { timeoutMs: 120000 });
      await p.send('Page.navigate', { url: BASE + page });
      await loaded; const loadS = (Date.now() - t0) / 1000;
      if (START[page]) await p.eval(START[page]);
      if (process.env.OO_PRE) await p.eval(process.env.OO_PRE);   // e.g. a setting to compare
      await sleep(SETTLE_S * 1000);
      const bytesAtSettle = bytes;
      const still = stats(await sample(p, SAMPLE_S), SAMPLE_S);
      if (process.env.OO_PROFILE) { await p.send('Profiler.enable'); await p.send('Profiler.setSamplingInterval', { interval: 500 }); await p.send('Profiler.start'); }
      if (MOTION[page]) await p.eval(MOTION[page]);
      const moving = MOTION[page] ? stats(await sample(p, SAMPLE_S), SAMPLE_S) : null;
      if (process.env.OO_PROFILE) {        // OO_PROFILE=1: self time by function during the moving sample
        const { profile } = await p.send('Profiler.stop'), self = new Map(), byId = new Map(profile.nodes.map(n => [n.id, n]));
        const dt = (profile.endTime - profile.startTime) / profile.samples.length / 1000;
        for (const id of profile.samples) { const cf = byId.get(id).callFrame, k = `${cf.functionName || '(anon)'} ${cf.url.split('/').pop()}:${cf.lineNumber + 1}`; self.set(k, (self.get(k) || 0) + dt); }
        console.log(`  profile ${mode} ${page}:`); for (const [k, ms] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`    ${ms.toFixed(0).padStart(6)} ms  ${k}`);
      }
      const m = Object.fromEntries((await p.send('Performance.getMetrics')).metrics.map(x => [x.name, x.value]));
      const err = await p.eval(`(document.querySelector('#err')?.textContent || '').slice(0, 200)`);
      const r = { mode, page, loadS: +loadS.toFixed(1), mbAtSettle: +(bytesAtSettle / 1e6).toFixed(1), requests, failed, still, moving, heapMB: +(m.JSHeapUsedSize / 1e6).toFixed(0), scriptS: +(m.ScriptDuration || 0).toFixed(1),
        big: big.sort((a, c) => c[1] - a[1]).slice(0, 6).map(([u, n]) => `${(n / 1e6).toFixed(1)} MB ${String(u).replace(BASE, '').slice(0, 90)}`), err };
      results.push(r);
      console.log(`${mode.padEnd(7)} ${page.padEnd(20)} load ${r.loadS}s  ${r.mbAtSettle} MB/${requests} req  still ${still.fps} fps (p95 ${still.p95Ms} ms)  moving ${moving?.fps} fps (median ${moving?.medianMs}, p95 ${moving?.p95Ms}, max ${moving?.maxMs} ms)  heap ${r.heapMB} MB  script ${r.scriptS}s${err ? '  ERR ' + err : ''}`);
      for (const x of r.big) console.log('          ' + x);
      await p.send('Page.close').catch(() => {});
    }
  } finally { await b.close(); }
}
await mkdir(new URL('../perf/', import.meta.url), { recursive: true });
const file = new URL(`../perf/${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`, import.meta.url);
await writeFile(file, JSON.stringify(results, null, 1));
console.log('wrote', file.pathname);
