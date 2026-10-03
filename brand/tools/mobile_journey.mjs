// mobile_journey.mjs — a first-time visitor on a phone, A to Z: the landing page, the 3D globe (drag, pinch, panels,
// zoom out to the Solar System), the Solar System view and the 2D map, all with touch gestures on an emulated
// mid-range Android phone (390x844 @3x, CPU 4x slower, "Fast 4G" network, empty cache).
//   node mobile_journey.mjs [base=http://localhost:8787/]          OO_NET=slow for "Slow 4G"
// For each step: screenshot (brand/perf/mobile/NN-step.png), frame times during the gesture, long tasks, new errors,
// bytes downloaded, JS heap, and a layout audit (sideways overflow, panels off screen or overlapping, small tap targets,
// tiny text). Summary table at the end; everything in brand/perf/mobile/report.json. Live feeds that must never see
// automated traffic are blocked, as in globe_shot.mjs.
import { launch, connect, sleep } from './cdp.mjs';
// OO_ANDROID=1: run on real Chrome in the Android emulator instead (adb reverse tcp:8787 tcp:8787 and
// adb forward tcp:9333 localabstract:chrome_devtools_remote first): its own screen, CPU and GPU, no emulation.
const ANDROID = process.env.OO_ANDROID === '1';
// the emulator's adbd sometimes resets its connection ("timeout expired while flushing socket"), which drops every
// adb forward/reverse: re-make both links before each step (idempotent, ~50 ms)
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const ADB = join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe');
// only re-make a link that is missing: replacing a live forward cuts the DevTools connection running through it
const adb = (...a) => spawnSync(ADB, a, { windowsHide: true, encoding: 'utf8' }).stdout || '';
const adbLinks = () => {
  if (!ANDROID) return;
  if (!adb('reverse', '--list').includes('tcp:8787')) adb('reverse', 'tcp:8787', 'tcp:8787');
  if (!adb('forward', '--list').includes('chrome_devtools_remote')) adb('forward', 'tcp:9333', 'localabstract:chrome_devtools_remote');
};
adbLinks();
import { writeFile, mkdir } from 'node:fs/promises';

const BASE = process.argv[2] || 'http://localhost:8787/';
const OUT = new URL(ANDROID ? '../perf/android/' : '../perf/mobile/', import.meta.url);
await mkdir(OUT, { recursive: true });
const W = 390, H = 844;
const NET = process.env.OO_NET === 'slow' ? { latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 0.75e6 / 8 } : { latency: 60, downloadThroughput: 9e6 / 8, uploadThroughput: 1.5e6 / 8 };

const AUDIT = `(() => {
  const vw = innerWidth, vh = innerHeight, out = { overflowX: document.documentElement.scrollWidth > vw + 1, offscreen: [], small: [], tinyText: 0, overlaps: [] };
  const shown = el => { const s = getComputedStyle(el); if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const name = el => (el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/)[0] : '')) + (el.textContent ? ' "' + el.textContent.trim().replace(/\\s+/g, ' ').slice(0, 24) + '"' : '');
  const inView = r => r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
  for (const el of document.querySelectorAll('button, a[href], input, select, [role=button], .ly, .go, .cj')) {
    if (!shown(el)) continue; const r = el.getBoundingClientRect(); if (!inView(r)) continue;
    let p = el.parentElement, clipped = false;   // inside a scroll container that hides it: not a problem
    while (p && p !== document.body) { const s = getComputedStyle(p); if (/(auto|scroll|hidden)/.test(s.overflowX + s.overflowY)) { const q = p.getBoundingClientRect(); if (r.right > q.right + 1 || r.left < q.left - 1) clipped = true; break; } p = p.parentElement; }
    if (!clipped && (r.right > vw + 1 || r.left < -1)) out.offscreen.push(name(el));
    if (!clipped && (r.width < 32 || r.height < 32)) out.small.push(name(el) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode());) { if (!n.textContent.trim()) continue; const el = n.parentElement; if (!el || !shown(el)) continue; const r = el.getBoundingClientRect(); if (!inView(r)) continue; if (parseFloat(getComputedStyle(el).fontSize) < 11) out.tinyText++; }
  const fixed = [...document.body.querySelectorAll('*')].filter(el => { const s = getComputedStyle(el); return (s.position === 'fixed') && shown(el) && el.getBoundingClientRect().width < vw * 2 && !/canvas|iframe/i.test(el.tagName) && el.id !== 'boot' && el.id !== 'load'; });
  const top = fixed.filter(el => !fixed.some(o => o !== el && o.contains(el)));
  for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) {
    const a = top[i].getBoundingClientRect(), b = top[j].getBoundingClientRect();
    const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left), iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (ix > 8 && iy > 8 && inView(a) && inView(b) && getComputedStyle(top[i]).pointerEvents !== 'none' && getComputedStyle(top[j]).pointerEvents !== 'none') out.overlaps.push(name(top[i]).slice(0, 30) + ' × ' + name(top[j]).slice(0, 30));
  }
  out.small = out.small.slice(0, 12); out.offscreen = out.offscreen.slice(0, 12); out.overlaps = out.overlaps.slice(0, 8);
  return out;
})()`;

const b = ANDROID ? await connect() : await launch({ windowSize: [W, H], args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-unsafe-swiftshader'] });
const report = [];
try {
  const p = await b.newPage();
  await p.send('Page.enable'); await p.send('Runtime.enable'); await p.send('Network.enable'); await p.send('Performance.enable'); await p.send('Log.enable');
  await p.send('Network.setBlockedURLs', { urls: ['*celestrak.org*', '*opensky-network.org*', '*adsb.lol*', '*adsb.fi*', '*airplanes.live*', '*earthquake.usgs.gov*', '*wheretheiss.at*'] });
  await p.send('Network.emulateNetworkConditions', { offline: false, ...NET });
  if (ANDROID) {   // a true first visit: no leftover tabs (background globes eat CPU) and no remembered choices or map view
    for (const t of await (await fetch('http://127.0.0.1:9333/json/list')).json()) if (t.type === 'page' && /localhost:8787/.test(t.url)) await fetch('http://127.0.0.1:9333/json/close/' + t.id).catch(() => {});
    await p.send('Storage.clearDataForOrigin', { origin: BASE.replace(/\/[^/]*$/, '').replace(/^(https?:\/\/[^/]+).*/, '$1'), storageTypes: 'all' });
  }
  if (!ANDROID) {
    await p.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 3, mobile: true, screenWidth: W, screenHeight: H });
    await p.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await p.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36', platform: 'Android' });
    await p.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  }
  let bytes = 0, errors = [];
  p.on('Network.loadingFinished', e => { bytes += e.encodedDataLength; });
  p.on('Runtime.exceptionThrown', e => errors.push('exception: ' + (e.exceptionDetails.exception?.description || e.exceptionDetails.text).split('\n')[0].slice(0, 160)));
  p.on('Runtime.consoleAPICalled', e => { if (e.type === 'error') errors.push('console: ' + e.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 160)); });

  // ---- helpers
  const touch = (type, pts) => p.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id, radiusX: 8, radiusY: 8, force: 1 })) });
  async function drag(x0, y0, x1, y1, ms = 600) {
    const n = Math.max(4, Math.round(ms / 32)); await touch('touchStart', [[x0, y0]]);
    for (let i = 1; i <= n; i++) { await touch('touchMove', [[x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n]]); await sleep(32); }
    await touch('touchEnd', []);
  }
  async function pinch(cx, cy, d0, d1, ms = 700) {   // d1 > d0: spread (zoom in), d1 < d0: pinch (zoom out)
    const n = Math.max(4, Math.round(ms / 32)), at = d => [[cx - d / 2, cy], [cx + d / 2, cy]];
    await touch('touchStart', at(d0));
    for (let i = 1; i <= n; i++) { await touch('touchMove', at(d0 + (d1 - d0) * i / n)); await sleep(32); }
    await touch('touchEnd', []);
  }
  async function tap(x, y) { await touch('touchStart', [[x, y]]); await sleep(60); await touch('touchEnd', []); }
  async function tapSel(sel, frame = '') {   // tap an element by selector (its centre); false if not visible
    const r = await p.eval(`(() => { const d = ${frame ? `document.querySelector(${JSON.stringify(frame)}).contentDocument` : 'document'}; const el = [...d.querySelectorAll(${JSON.stringify(sel)})].find(e => e.getBoundingClientRect().width > 0); if (!el) return null; el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const q = el.getBoundingClientRect(); return [q.left + q.width / 2, q.top + q.height / 2]; })()`);
    if (!r) return false; await tap(r[0], r[1]); return true;
  }
  const startFrames = () => p.eval(`(() => { window.__f = []; let l = performance.now(); window.__lt = []; try { new PerformanceObserver(l2 => { for (const e of l2.getEntries()) window.__lt.push(e.duration); }).observe({ type: 'longtask' }); } catch (e) {} const f = t => { window.__f.push(t - l); l = t; if (window.__f.length < 5000) requestAnimationFrame(f); }; requestAnimationFrame(f); })()`);
  const stopFrames = async () => { const [f, lt] = await p.eval('[window.__f.splice(0), (window.__lt || []).splice(0)]'); const s = [...f].sort((a, c) => a - c);
    return f.length ? { frames: f.length, fps: +(1000 * f.length / f.reduce((a, c) => a + c, 0)).toFixed(0), p50: +s[s.length >> 1].toFixed(0), p95: +s[Math.floor(s.length * 0.95)].toFixed(0), worst: +s[s.length - 1].toFixed(0), longTasks: lt.length, longMs: Math.round(lt.reduce((a, c) => a + c, 0)) } : null; };
  let n = 0;
  async function step(name, fn, { gesture = false } = {}) {
    adbLinks();
    const e0 = errors.length, b0 = bytes, t0 = Date.now();
    if (gesture) await startFrames().catch(() => {});
    let note = '';
    try { note = (await fn()) || ''; } catch (e) { note = 'STEP FAILED: ' + e.message; }
    const frames = gesture ? await stopFrames().catch(() => null) : null;
    const m = Object.fromEntries((await p.send('Performance.getMetrics')).metrics.map(x => [x.name, x.value]));
    const audit = await p.eval(AUDIT).catch(e => ({ error: e.message }));
    const file = `${String(++n).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
    if (ANDROID) {   // Android's own screen capture: a big DevTools screenshot of a WebGL page reset the adb link every time
      const png = spawnSync(ADB, ['exec-out', 'screencap', '-p'], { windowsHide: true, maxBuffer: 64e6 }).stdout;
      if (png && png.length) await writeFile(new URL(file, OUT), png);
    } else {
      const shot = await p.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
      if (shot) await writeFile(new URL(file, OUT), Buffer.from(shot.data, 'base64'));
    }
    const r = { step: name, s: +((Date.now() - t0) / 1000).toFixed(1), mb: +((bytes - b0) / 1e6).toFixed(1), heapMB: Math.round(m.JSHeapUsedSize / 1e6), frames, errors: errors.slice(e0), audit, note, file };
    report.push(r);
    const f = frames ? `${frames.fps} fps p95 ${frames.p95} worst ${frames.worst} ms, ${frames.longTasks} long tasks (${frames.longMs} ms)` : '';
    console.log(`${String(n).padStart(2)} ${name.padEnd(34)} ${String(r.s).padStart(5)} s ${String(r.mb).padStart(5)} MB heap ${String(r.heapMB).padStart(3)}  ${f}${note ? '  · ' + note : ''}`);
    if (r.errors.length) console.log('     errors: ' + r.errors.slice(0, 4).join(' | '));
    if (audit && !audit.error) {
      const a = audit, bits = [a.overflowX && 'sideways scroll', a.offscreen.length && 'off screen: ' + a.offscreen.join(', '), a.overlaps.length && 'overlap: ' + a.overlaps.join(', '), a.small.length && 'small taps: ' + a.small.join(', '), a.tinyText && a.tinyText + ' tiny text'].filter(Boolean);
      if (bits.length) console.log('     layout: ' + bits.join(' | '));
    }
  }
  const nav = async (path, waitJs, ms = 60000) => {
    const loaded = p.waitFor('Page.loadEventFired', { timeoutMs: 120000 }); const t0 = Date.now();
    await p.send('Page.navigate', { url: BASE + path }); await loaded; let load = (Date.now() - t0) / 1000;
    if (await p.eval(`location.protocol === 'chrome-error:'`)) {   // adb dropped the reverse link: re-make it and retry once
      adbLinks(); await sleep(1000); const again = p.waitFor('Page.loadEventFired', { timeoutMs: 120000 });
      await p.send('Page.navigate', { url: BASE + path }); await again; load = (Date.now() - t0) / 1000;
      if (await p.eval(`location.protocol === 'chrome-error:'`)) throw new Error('page did not load (the phone cannot reach this PC)');
    }
    if (waitJs) await p.poll(waitJs, { timeoutMs: ms, intervalMs: 300 }).catch(() => {});
    return `load event ${load.toFixed(1)} s, ready ${((Date.now() - t0) / 1000).toFixed(1)} s`;
  };

  // ---- A. landing page
  await step('landing: open', () => nav('index.html', `document.readyState === 'complete'`));
  await step('landing: scroll to launch', async () => { await p.eval(`document.querySelector('#launch').scrollIntoView()`); await sleep(1500); });

  // ---- B. the 3D globe, as a first-time visitor
  await step('globe: open (boot screen gone)', () => nav('globe.html', `!document.querySelector('#boot') || document.querySelector('#boot').classList.contains('out')`, 90000));
  await step('globe: settle 5 s', async () => { await sleep(5000); }, { gesture: true });
  await step('globe: one-finger drag', async () => { await drag(120, 420, 300, 380, 900); await drag(300, 380, 140, 460, 900); await sleep(800); }, { gesture: true });
  await step('globe: pinch in x3', async () => { for (let i = 0; i < 3; i++) { await pinch(195, 420, 60, 300, 700); await sleep(500); } await sleep(1500); return 'height ' + Math.round(await p.eval('OO3D.viewer.camera.positionCartographic.height / 1000')) + ' km'; }, { gesture: true });
  await step('globe: open Layers', async () => (await tapSel('[data-tab=layers]')) ? '' : 'no Layers tab');
  await step('globe: close Layers', async () => (await tapSel('[data-tab=layers]')) ? '' : 'no Layers tab');
  await step('globe: Explore sheet, tap Near misses', async () => { if (!(await tapSel('[data-tab=explore]'))) return 'no Explore tab'; await sleep(500); return (await tapSel('#msheet [data-go=conj]')) ? '' : 'no destination'; });
  await step('globe: close card', async () => (await tapSel('#card .x')) ? '' : 'no close button');
  await step('globe: tap a satellite', async () => {
    const xy = await p.eval(`(() => { const S = OO3D.Sats, C = Cesium, sc = OO3D.viewer.scene; const occ = new C.EllipsoidalOccluder(C.Ellipsoid.WGS84, OO3D.viewer.camera.positionWC); for (const s of S.list) { if (!s.pt || !s.pt.show || !occ.isPointVisible(s.pt.position)) continue; const w = C.SceneTransforms.worldToWindowCoordinates ? C.SceneTransforms.worldToWindowCoordinates(sc, s.pt.position) : C.SceneTransforms.wgs84ToWindowCoordinates(sc, s.pt.position); if (w && w.x > 40 && w.x < innerWidth - 40 && w.y > 120 && w.y < innerHeight - 160) return [w.x, w.y, s.name]; } return null; })()`);
    if (!xy) return 'no satellite on screen'; await tap(xy[0], xy[1]); await sleep(1200);
    return (await p.eval(`document.querySelector('#card').classList.contains('show')`)) ? 'card opened for ' + xy[2] : 'tap missed ' + xy[2];
  });
  await step('globe: pinch out to the Solar System', async () => {
    await tapSel('#card .x');
    let n = 0; for (; n < 24; n++) { await pinch(195, 420, 300, 50, 600); await sleep(250); if (await p.eval(`document.querySelector('iframe')?.style.opacity === '1'`)) break; }
    await sleep(2500); return (await p.eval(`document.querySelector('iframe')?.style.opacity === '1'`)) ? `handed over after ${n + 1} pinches` : 'still on the globe at ' + Math.round(await p.eval('OO3D.viewer.camera.positionCartographic.height / 1000')) + ' km';
  }, { gesture: true });

  // ---- C. Solar System on its own
  await step('solar: open', () => nav('solar.html', `document.querySelector('#load')?.classList.contains('gone')`, 90000));
  await step('solar: settle 6 s', async () => { await sleep(6000); }, { gesture: true });
  await step('solar: drag + pinch out x3', async () => { await drag(100, 420, 300, 400, 800); for (let i = 0; i < 3; i++) { await pinch(195, 420, 300, 60, 700); await sleep(400); } await sleep(1000); }, { gesture: true });
  await step('solar: open menu', async () => (await tapSel('#menuBtn')) ? '' : 'no menu button');
  await step('solar: close menu', async () => (await tapSel('#menuBtn')) ? '' : 'no menu button');
  await step('solar: tap a ladder rung', async () => (await tapSel('.rung[data-i="3"]')) ? (await sleep(3500), '') : 'no rung', { gesture: true });

  // ---- D. the 2D map
  await step('map: open', () => nav('open-overwatch.html', `document.readyState === 'complete'`));
  await step('map: start silent', async () => { await sleep(1500); const ok = await p.eval(`(() => { const b = [...document.querySelectorAll('button')].find(b => /silent/i.test(b.textContent) && b.getBoundingClientRect().width); if (!b) return false; const q = b.getBoundingClientRect(); return [q.left + q.width / 2, q.top + q.height / 2]; })()`); if (!ok) return 'no silent button'; await tap(ok[0], ok[1]); await sleep(2500); });
  await step('map: pick "Space"', async () => { const ok = await p.eval(`(() => { const b = [...document.querySelectorAll('button')].find(b => /^\\s*SPACE/i.test(b.textContent) && b.getBoundingClientRect().width); if (!b) return false; const q = b.getBoundingClientRect(); return [q.left + q.width / 2, q.top + q.height / 2]; })()`); if (!ok) return 'no Space preset'; await tap(ok[0], ok[1]); await sleep(4000); });
  await step('map: drag + pinch', async () => { await drag(100, 450, 300, 400, 700); await pinch(195, 450, 80, 260, 700); await sleep(1500); }, { gesture: true });
  await step('map: Layers tab', async () => { const ok = await p.eval(`(() => { const b = [...document.querySelectorAll('button, a')].find(b => /^\\s*LAYERS\\s*$/i.test(b.textContent) && b.getBoundingClientRect().width); if (!b) return false; const q = b.getBoundingClientRect(); return [q.left + q.width / 2, q.top + q.height / 2]; })()`); if (!ok) return 'no Layers tab'; await tap(ok[0], ok[1]); await sleep(1500); });
  await step('map: back to Map tab', async () => { const ok = await p.eval(`(() => { const b = [...document.querySelectorAll('button, a')].find(b => /^\\s*MAP\\s*$/i.test(b.textContent) && b.getBoundingClientRect().width); if (!b) return false; const q = b.getBoundingClientRect(); return [q.left + q.width / 2, q.top + q.height / 2]; })()`); if (!ok) return 'no Map tab'; await tap(ok[0], ok[1]); await sleep(1500); });
} finally {
  await writeFile(new URL('report.json', OUT), JSON.stringify(report, null, 1));
  await b.close();
}
