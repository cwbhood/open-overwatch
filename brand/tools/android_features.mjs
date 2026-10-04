// android_features.mjs — the newer globe features on the Android emulator, by touch (see docs/TESTING.md):
//   OO_ANDROID is implied. Needs the emulator running with adb links (mobile_journey.mjs makes them), and the server on :8787.
//   node android_features.mjs      screenshots in brand/perf/android-features/
// A country tapped on the Earth gives its dossier; the Explore sheet fits and scrolls; Weather's panel fits; the tour starts from the
// sheet and a touch stops it; a shared link opened in a fresh page restores the view, the layers and the country.
import { connect, sleep } from './cdp.mjs';
import { windFixture } from './wind_fixture.mjs';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADB = join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe');
const adb = (...a) => spawnSync(ADB, a, { windowsHide: true, maxBuffer: 1 << 26 });
if (!adb('reverse', '--list').stdout.toString().includes('tcp:8787')) adb('reverse', 'tcp:8787', 'tcp:8787');
if (!adb('forward', '--list').stdout.toString().includes('chrome_devtools_remote')) adb('forward', 'tcp:9333', 'localabstract:chrome_devtools_remote');
const OUT = new URL('../perf/android-features/', import.meta.url); await mkdir(OUT, { recursive: true });
const shot = async name => { const r = adb('exec-out', 'screencap', '-p'); await writeFile(fileURLToPath(new URL(name + '.png', OUT)), r.stdout); };
const results = []; const ok = (name, pass, note = '') => { results.push({ name, pass, note }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${note ? '  · ' + note : ''}`); };

const b = await connect();
async function open(url) {
  for (const t of await (await fetch('http://127.0.0.1:9333/json/list')).json()) if (t.type === 'page' && /localhost:8787/.test(t.url)) await fetch('http://127.0.0.1:9333/json/close/' + t.id).catch(() => {});
  const p = await b.newPage('about:blank'); const errs = [];
  for (const d of ['Page', 'Runtime', 'Network', 'Fetch']) await p.send(d + '.enable');
  p.on('Runtime.exceptionThrown', e => errs.push(String(e.exceptionDetails.exception?.description || e.exceptionDetails.text).slice(0, 200)));
  await p.send('Network.setBlockedURLs', { urls: ['*celestrak.org*', '*opensky-network.org*', '*adsb.lol*', '*adsb.fi*', '*airplanes.live*', '*earthquake.usgs.gov*', '*wheretheiss.at*', '*api.open-meteo.com*', '*gdeltproject*'] });
  await p.send('Fetch.enable', { patterns: [{ urlPattern: '*data/wind.json*' }] });
  p.on('Fetch.requestPaused', e => p.send('Fetch.fulfillRequest', { requestId: e.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: Buffer.from(JSON.stringify(windFixture())).toString('base64') }).catch(() => {}));
  const loaded = p.waitFor('Page.loadEventFired', { timeoutMs: 120000 });
  await p.send('Page.navigate', { url }); await loaded;
  await p.poll("!document.querySelector('#boot') || document.querySelector('#boot').classList.contains('out')", { timeoutMs: 90000 }); await sleep(6000);
  p.errs = errs; return p;
}
const touch = (p, type, pts) => p.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id, radiusX: 8, radiusY: 8, force: 1 })) });
const tapAt = async (p, x, y) => { await touch(p, 'touchStart', [[x, y]]); await sleep(70); await touch(p, 'touchEnd', []); };
const tapSel = async (p, sel) => { const xy = await p.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const q = e.getBoundingClientRect(); return q.width ? [q.left + q.width / 2, q.top + q.height / 2] : null; })()`); if (!xy) return false; await tapAt(p, xy[0], xy[1]); return true; };

try {
  let p = await open('http://localhost:8787/globe.html');
  ok('phone mode on, heavy layers off', await p.eval(`document.body.classList.contains('m') && !OO3D.L.companies.on && !OO3D.L.volcanoes.on && !OO3D.L.aurora.on`));

  // 1. tap a country on the Earth
  await p.eval(`OO3D.viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(139, 36, 3.0e6), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } })`); await sleep(2000);
  const xy = await p.eval(`(() => { const w = Cesium.SceneTransforms.worldToWindowCoordinates(OO3D.viewer.scene, Cesium.Cartesian3.fromDegrees(138, 36.2)); return [w.x, w.y]; })()`);
  await tapAt(p, xy[0], xy[1]); await sleep(3500);
  const card = await p.eval(`document.querySelector('#card').innerText.slice(0, 200)`);
  ok('tapping Japan opens its dossier', /JAPAN/i.test(card) && /Tokyo/.test(card), card.split('\n').slice(0, 3).join(' | ')); await shot('01-country-dossier');
  const fits = await p.eval(`(() => { const r = document.querySelector('#card').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.right <= innerWidth + 1; })()`);
  ok('the dossier card fits the screen', fits);
  await tapSel(p, '#card .x'); await sleep(500);

  // 2. the Explore sheet
  await tapSel(p, '[data-tab=explore]'); await sleep(700); await shot('02-explore-sheet');
  const sheet = await p.eval(`(() => { const s = document.querySelector('#msheet'), r = s.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: innerHeight, scrolls: s.scrollHeight > s.clientHeight, items: s.querySelectorAll('[data-go]').length, share: !!s.querySelector('[data-share]'), tour: !!s.querySelector('[data-go=tour]') }; })()`);
  ok('Explore sheet fits and offers Tour, Flybys and the link', sheet.top >= 0 && sheet.bottom <= sheet.h && sheet.items >= 10 && sheet.share && sheet.tour, JSON.stringify(sheet));
  await tapSel(p, '#msheet [data-go=weather]'); await p.poll('OO3D.Weather.end', { timeoutMs: 40000 }); await sleep(2500);
  await tapSel(p, '[data-set=wind]'); await tapSel(p, '[data-set=temp]'); await sleep(5000); await shot('03-weather-panel');
  const wx = await p.eval(`(() => { const r = document.querySelector('#wx').getBoundingClientRect(), d = document.querySelector('#mdock').getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), dockTop: Math.round(d.top), right: Math.round(r.right), w: innerWidth }; })()`);
  ok('weather panel sits above the dock, inside the screen', wx.top > 0 && wx.bottom <= wx.dockTop + 1 && wx.right <= wx.w + 1, JSON.stringify(wx));
  await tapSel(p, '#wx .x'); await sleep(800);

  // 3. the tour, stopped by a touch
  await tapSel(p, '[data-tab=explore]'); await sleep(600); await tapSel(p, '#msheet [data-go=tour]'); await sleep(6000); await shot('04-tour-caption');
  ok('the tour is running with a caption', await p.eval(`OO3D.Tour.running && document.querySelector('#tourcap').classList.contains('show')`), await p.eval(`document.querySelector('#tourcap').innerText.split(String.fromCharCode(10))[0]`));
  await tapAt(p, 200, 400); const t0 = Date.now(); while ((await p.eval('OO3D.Tour.running')) && Date.now() - t0 < 25000) await sleep(500);
  ok('a touch stops the tour', !(await p.eval('OO3D.Tour.running')), `${Date.now() - t0} ms`);

  // 4. a shared link opens in a fresh page with the same view
  await p.eval(`OO3D.L.volcanoes.on = true; OO3D.L.sun.on = true; OO3D.viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(14, 41, 2.5e6), orientation: { heading: 0.3, pitch: -1.2, roll: 0 } })`);
  const link = await p.eval('OO3D.Share.link()'); const hash = '#' + link.split('#')[1];
  p = await open('http://localhost:8787/globe.html' + hash); await sleep(3000);
  const back = await p.eval(`(() => { const c = OO3D.viewer.camera.positionCartographic; return { lon: +Cesium.Math.toDegrees(c.longitude).toFixed(2), lat: +Cesium.Math.toDegrees(c.latitude).toFixed(2), km: Math.round(c.height / 1000), volc: OO3D.L.volcanoes.on, sun: OO3D.L.sun.on, quakes: OO3D.L.quakes.on, dockOff: document.querySelector('[data-ly=volcanoes]') ? !document.querySelector('[data-ly=volcanoes]').classList.contains('off') : null }; })()`);
  ok('a shared link restores the view and layers', Math.abs(back.lon - 14) < 0.1 && Math.abs(back.lat - 41) < 0.1 && Math.abs(back.km - 2500) < 5 && back.volc && back.sun, JSON.stringify(back)); await shot('05-restored-link');
  ok('no JavaScript errors', p.errs.length === 0, p.errs.slice(0, 2).join(' | '));
} finally {
  await writeFile(fileURLToPath(new URL('report.json', OUT)), JSON.stringify(results, null, 1)); await b.close();
}
console.log(results.every(r => r.pass) ? 'all passed' : results.filter(r => !r.pass).length + ' failed');
