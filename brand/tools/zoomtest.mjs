// zoomtest.mjs — the scroll-wheel zoom out from Earth through the hand-off to the Solar System and beyond, with real
// mouse-wheel events, timing every frame. Prints a per-second timeline (phase, height/distance, fps, worst frame) and,
// with OO_PROFILE=1, where the main thread spent the time.
//   node zoomtest.mjs [desktop|phone] [seconds=30] [wheelDeltaY=100]      OO_BACK=s: then scroll back in for s seconds
// Needs serve.js on :8787. Live feeds that must never see automated traffic are blocked (as in globe_shot.mjs).
import { launch, sleep } from './cdp.mjs';

const [mode = 'desktop', secArg = '30', deltaArg = '100'] = process.argv.slice(2);
const SECONDS = +secArg, DELTA = +deltaArg;
const P = mode === 'phone' ? { width: 390, height: 844, dpr: 3, mobile: true, cpu: 4 } : { width: 1600, height: 900, dpr: 1, mobile: false, cpu: 1 };
const b = await launch({ windowSize: [P.width, P.height], args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-unsafe-swiftshader'] });
try {
  const p = await b.newPage();
  await p.send('Page.enable'); await p.send('Runtime.enable'); await p.send('Network.enable');
  await p.send('Network.setBlockedURLs', { urls: ['*celestrak.org*', '*opensky-network.org*', '*adsb.lol*', '*adsb.fi*', '*airplanes.live*', '*earthquake.usgs.gov*', '*wheretheiss.at*'] });
  await p.send('Network.setCacheDisabled', { cacheDisabled: true });
  await p.send('Emulation.setDeviceMetricsOverride', { width: P.width, height: P.height, deviceScaleFactor: P.dpr, mobile: P.mobile });
  await p.send('Emulation.setCPUThrottlingRate', { rate: P.cpu });
  const loaded = p.waitFor('Page.loadEventFired', { timeoutMs: 120000 });
  if (process.env.OO_LAYERS_OFF) await p.send('Page.addScriptToEvaluateOnNewDocument', { source: `for (const id of ${JSON.stringify(process.env.OO_LAYERS_OFF.split(','))}) localStorage.setItem('oo3d.ly.' + id, 'false');` });   // OO_LAYERS_OFF=companies,volcanoes: switch layers off to find the one that costs
  await p.send('Page.navigate', { url: 'http://localhost:8787/globe.html' + (process.env.OO_QUERY || '') });
  await loaded; await sleep(12000);
  // in-page recorder: frame intervals with the phase and scale at each frame
  await p.eval(`(() => { window.__z = []; let last = performance.now();
    const f = t => { const S = document.querySelector('iframe')?.contentWindow?.OOSS, act = S && document.querySelector('iframe').style.opacity === '1';
      const h = OO3D.viewer.camera.positionCartographic.height, d = act ? S.camera.position.distanceTo(S.nav.focus.pos) : null;
      window.__z.push([t - last, act ? 'solar' : 'globe', act ? d : h / 1.496e11]); last = t; requestAnimationFrame(f); };
    requestAnimationFrame(f); })()`);
  if (process.env.OO_PROFILE) { await p.send('Profiler.enable'); await p.send('Profiler.setSamplingInterval', { interval: 500 }); await p.send('Profiler.start'); }
  const t0 = Date.now(), cx = P.width / 2, cy = P.height / 2;
  while (Date.now() - t0 < SECONDS * 1000) {
    await p.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: DELTA });
    await sleep(33);
  }
  const back = +(process.env.OO_BACK || 0);   // OO_BACK=seconds: then scroll back in to Earth for that long
  const t1 = Date.now();
  while (Date.now() - t1 < back * 1000) {
    await p.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: -DELTA });
    await sleep(33);
  }
  const z = await p.eval('window.__z');
  // per-second timeline
  let acc = 0, bucket = [];
  const flush = () => { if (!bucket.length) return; const ms = bucket.map(x => x[0]).sort((a, c) => a - c), last = bucket[bucket.length - 1];
    console.log(`${(acc / 1000).toFixed(0).padStart(3)} s  ${last[1].padEnd(5)}  ${last[2].toExponential(1).padStart(8)} AU  ${String(bucket.length).padStart(3)} fps  median ${ms[ms.length >> 1].toFixed(0).padStart(3)} ms  worst ${ms[ms.length - 1].toFixed(0).padStart(4)} ms`); bucket = []; };
  let next = 1000;
  for (const x of z) { acc += x[0]; bucket.push(x); if (acc >= next) { flush(); next += 1000; } }
  flush();
  const all = z.map(x => x[0]).sort((a, c) => a - c);
  console.log(`total ${z.length} frames, median ${all[all.length >> 1].toFixed(1)} ms, p95 ${all[Math.floor(all.length * 0.95)].toFixed(1)} ms, frames > 50 ms: ${all.filter(x => x > 50).length}`);
  if (process.env.OO_PROFILE) {
    const { profile } = await p.send('Profiler.stop'), self = new Map(), byId = new Map(profile.nodes.map(n => [n.id, n]));
    const dt = (profile.endTime - profile.startTime) / profile.samples.length / 1000;
    for (const id of profile.samples) { const cf = byId.get(id).callFrame, k = `${cf.functionName || '(anon)'} ${cf.url.split('/').pop()}:${cf.lineNumber + 1}`; self.set(k, (self.get(k) || 0) + dt); }
    for (const [k, ms] of [...self].sort((a, c) => c[1] - a[1]).slice(0, 30)) console.log(`  ${ms.toFixed(0).padStart(6)} ms  ${k}`);
  }
} finally { await b.close(); }
