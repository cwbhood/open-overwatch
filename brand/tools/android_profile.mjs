// android_profile.mjs — profile one interaction in Chrome on the Android emulator (see docs/TESTING.md):
//   node android_profile.mjs map|mapspace|mappinch|mapspacepinch|handoff
// map: the 2D map, a 4-second finger drag after "Enter silent" and "Just show the map"; mapspace: the same after the Space
// preset (ISS selected, its details sheet open, ground track drawn); mappinch / mapspacepinch: two pinches in and out instead.
// handoff: the globe, pinching straight out to the Solar System right after it appears.
// Prints frame timing, long tasks and where the main thread spent its time (self time by function).
import { connect, sleep } from './cdp.mjs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ADB = join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe');
const adb = (...a) => spawnSync(ADB, a, { windowsHide: true, encoding: 'utf8' }).stdout || '';
if (!adb('reverse', '--list').includes('tcp:8787')) adb('reverse', 'tcp:8787', 'tcp:8787');
if (!adb('forward', '--list').includes('chrome_devtools_remote')) adb('forward', 'tcp:9333', 'localabstract:chrome_devtools_remote');
const what = process.argv[2] || 'map';
const b = await connect(), p = await b.newPage('about:blank');
try {
  for (const d of ['Page', 'Runtime', 'Network']) await p.send(d + '.enable');
  for (const t of await (await fetch('http://127.0.0.1:9333/json/list')).json()) if (t.type === 'page' && /localhost:8787/.test(t.url)) await fetch('http://127.0.0.1:9333/json/close/' + t.id).catch(() => {});
  await p.send('Storage.clearDataForOrigin', { origin: 'http://localhost:8787', storageTypes: 'all' });   // a first visit every time
  await p.send('Network.setBlockedURLs', { urls: ['*celestrak.org*', '*earthquake.usgs.gov*', '*wheretheiss.at*'] });
  const touch = (type, pts) => p.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id, radiusX: 8, radiusY: 8, force: 1 })) });
  const tapText = async re => { const xy = await p.eval(`(() => { const b = [...document.querySelectorAll('button, a')].find(b => ${re}.test(b.textContent) && b.getBoundingClientRect().width); if (!b) return null; const q = b.getBoundingClientRect(); return [q.left + q.width / 2, q.top + q.height / 2]; })()`); if (xy) { await touch('touchStart', [xy]); await sleep(60); await touch('touchEnd', []); } return !!xy; };
  const loaded = p.waitFor('Page.loadEventFired', { timeoutMs: 120000 });
  if (what.startsWith('map')) {
    await p.send('Page.navigate', { url: 'http://localhost:8787/open-overwatch.html' }); await loaded; await sleep(2000);
    await tapText('/silent/i'); await sleep(2500); await tapText(!what.includes('space') ? '/just show the map/i' : '/^\s*SPACE/i'); await sleep(6000);
  } else {
    await p.send('Page.navigate', { url: 'http://localhost:8787/globe.html' }); await loaded;
    await p.poll(`!document.querySelector('#boot') || document.querySelector('#boot').classList.contains('out')`, { timeoutMs: 60000 }); await sleep(1500);
  }
  if (process.env.OO_CSS) await p.eval(`(() => { const st = document.createElement('style'); st.textContent = ${JSON.stringify(process.env.OO_CSS)}; document.head.appendChild(st); })()`);   // A/B a style
  await p.eval(`(() => { window.__f = []; window.__lt = []; let l = performance.now(); new PerformanceObserver(o => { for (const e of o.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ type: 'longtask' });
    const f = t => { window.__f.push(t - l); l = t; requestAnimationFrame(f); }; requestAnimationFrame(f); })()`);
  await p.send('Profiler.enable'); await p.send('Profiler.setSamplingInterval', { interval: 500 }); await p.send('Profiler.start');
  const W = await p.eval('innerWidth'), H = await p.eval('innerHeight');
  if (what.endsWith('pinch')) {   // two pinches in and out, like the journey's step
    for (let k = 0; k < 2; k++) for (const [d0, d1] of [[80, 260], [260, 80]]) {
      const cx = W / 2, cy = H * 0.35, n = 20, at = d => [[cx - d / 2, cy], [cx + d / 2, cy]];
      await touch('touchStart', at(d0)); for (let i = 1; i <= n; i++) { await touch('touchMove', at(d0 + (d1 - d0) * i / n)); await sleep(33); } await touch('touchEnd', []); await sleep(700);
    }
  } else if (what.startsWith('map')) {
    for (let k = 0; k < 4; k++) {   // back and forth, 1 s each
      const x0 = W * 0.2, x1 = W * 0.8, y = H * 0.55; await touch('touchStart', [[k % 2 ? x1 : x0, y]]);
      for (let i = 1; i <= 30; i++) { const u = i / 30; await touch('touchMove', [[k % 2 ? x1 + (x0 - x1) * u : x0 + (x1 - x0) * u, y + Math.sin(u * 6) * 20]]); await sleep(33); }
      await touch('touchEnd', []);
    }
  } else {
    for (let i = 0; i < 45; i++) {
      const cx = W / 2, cy = H / 2, n = 18; await touch('touchStart', [[cx - 150, cy], [cx + 150, cy]]);
      for (let j = 1; j <= n; j++) { const d = 300 - 260 * j / n; await touch('touchMove', [[cx - d / 2, cy], [cx + d / 2, cy]]); await sleep(33); }
      await touch('touchEnd', []); await sleep(200);
      if (await p.eval(`document.querySelector('iframe')?.style.opacity === '1'`)) { console.log('handed over after', i + 1, 'pinches'); break; }
    }
    await sleep(2500);
  }
  const { profile } = await p.send('Profiler.stop');
  const [frames, lt] = await p.eval('[window.__f, window.__lt]'), s = [...frames].sort((a, c) => a - c);
  console.log(`${frames.length} frames · median ${s[s.length >> 1].toFixed(0)} ms · p95 ${s[Math.floor(s.length * 0.95)].toFixed(0)} ms · worst ${s[s.length - 1].toFixed(0)} ms · ${lt.length} long tasks (${lt.reduce((a, c) => a + c, 0)} ms): ${lt.slice(0, 12).join(', ')}`);
  const self = new Map(), byId = new Map(profile.nodes.map(n => [n.id, n])), dt = (profile.endTime - profile.startTime) / profile.samples.length / 1000;
  for (const id of profile.samples) { const cf = byId.get(id).callFrame, k = `${cf.functionName || '(anon)'} ${cf.url.split('/').pop()}:${cf.lineNumber + 1}`; self.set(k, (self.get(k) || 0) + dt); }
  for (const [k, ms] of [...self].sort((a, c) => c[1] - a[1]).slice(0, 25)) console.log(`  ${ms.toFixed(0).padStart(6)} ms  ${k}`);
  if (process.env.OO_CALLERS) {   // who calls the named native function(s): call paths with time
    const parent = new Map(); for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
    const re = new RegExp(process.env.OO_CALLERS), paths = new Map();
    for (const id of profile.samples) { const n = byId.get(id); if (!re.test(n.callFrame.functionName)) continue;
      const st = []; for (let q = parent.get(id); q != null && st.length < 7; q = parent.get(q)) { const cf = byId.get(q).callFrame; if (cf.functionName || cf.url) st.push(`${cf.functionName || '(anon)'}@${cf.url.split('/').pop()}:${cf.lineNumber + 1}`); }
      const k = n.callFrame.functionName + ' < ' + st.join(' < '); paths.set(k, (paths.get(k) || 0) + dt); }
    for (const [k, ms] of [...paths].sort((a, c) => c[1] - a[1]).slice(0, 6)) console.log(`  ${ms.toFixed(0).padStart(6)} ms  ${k}`);
  }
} finally { await b.close(); }
