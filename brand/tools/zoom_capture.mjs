// zoom_capture.mjs — the 30-second clip: one unbroken zoom from a London street, past the aircraft and every tracked
// satellite, through the hand-off into the Solar System, out to the stars, into another solar system (TRAPPIST-1) and
// back out to the cosmic web. Vertical 1080x1920, 30 fps, as frame_#####.jpg for encode_video.py.
//   node zoom_capture.mjs [outDir]          (default <WORK>/footage/zoom) — needs serve.js on :8787
// Frame stepping, as in capture.mjs: each frame sets the clock and the camera, waits until the view has loaded, then
// takes the screenshot, so the footage is smooth however long a frame takes. CelesTrak is blocked (satellites come
// from the site's copy); the aircraft feeds are fetched once.
import { launch, sleep, WORK } from './cdp.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT = process.argv[2] || path.join(WORK, 'footage', 'zoom');
const FPS = 30, W = 540, H = 960;
// open on a public landmark in whichever big city is nearest late morning right now (daylight streets, busy skies)
const CITIES = [['London', 51.4990, -0.1246], ['New York', 40.7484, -73.9857], ['Tokyo', 35.6586, 139.7454], ['Sydney', -33.8568, 151.2153],
  ['Singapore', 1.2834, 103.8607], ['Dubai', 25.1972, 55.2744], ['Los Angeles', 34.0522, -118.2437], ['São Paulo', -23.5505, -46.6333]];
const utcH = new Date().getUTCHours() + new Date().getUTCMinutes() / 60, solarDiff = lon => Math.abs((((utcH + lon / 15 - 11) % 24) + 36) % 24 - 12);
const [CITY, LAT, LON] = CITIES.slice().sort((a, b) => solarDiff(a[2]) - solarDiff(b[2]))[0];
console.log('city', CITY);
const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2, lerp = (a, b, t) => a + (b - a) * t;
const logLerp = (a, b, t) => Math.exp(lerp(Math.log(a), Math.log(b), t));

await mkdir(OUT, { recursive: true });
const b = await launch({ windowSize: [W, H], args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
let n = 0;
try {
  const p = await b.newPage();
  for (const d of ['Page', 'Runtime', 'Network']) await p.send(d + '.enable');
  await p.send('Network.setBlockedURLs', { urls: ['*celestrak.org*', '*earthquake.usgs.gov*', '*wheretheiss.at*', '*airplanes.live*'] });
  p.on('Runtime.exceptionThrown', e => console.log('EXCEPTION', (e.exceptionDetails.exception?.description || e.exceptionDetails.text).slice(0, 300)));
  await p.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
  const loaded = p.waitFor('Page.loadEventFired', { timeoutMs: 120000 });
  await p.send('Page.navigate', { url: 'http://localhost:8787/globe.html' }); await loaded;
  await p.poll(`!document.querySelector('#boot') || document.querySelector('#boot').classList.contains('out')`, { timeoutMs: 60000 });
  await sleep(16000);   // satellites, aircraft, the preloaded Solar System view
  console.log('ready', JSON.stringify(await p.eval(`({ sats: OO3D.Sats.list.length, air: OO3D.Air.map.size, solar: !!document.querySelector('iframe')?.contentWindow?.OOSS })`)));
  // capture set-up: paused clock we step ourselves, no UI chrome, a caption layer
  await p.eval(`(() => {
    window.__T0 = OO3D.time.jd(); OO3D.time.setJd(window.__T0, 0); OO3D.L.labels.on = false; OO3D.applyVisibility();
    const st = document.createElement('style'); st.textContent = '#top,#band,#dock,#card,#credits,#hover,#toast,#nerd{display:none!important}' +
      '#cap{position:fixed;left:0;right:0;bottom:150px;z-index:100;text-align:center;font:800 30px/1.15 "Big Shoulders Display",system-ui;letter-spacing:.06em;text-transform:uppercase;color:#fff;text-shadow:0 2px 18px #000,0 0 4px #000;transition:opacity .3s}' +
      '#cap small{display:block;margin-top:8px;font:500 15px/1.3 "IBM Plex Mono",monospace;letter-spacing:.04em;text-transform:none;color:#cfe;opacity:.9}';
    document.head.appendChild(st); const c = document.createElement('div'); c.id = 'cap'; document.body.appendChild(c);
  })()`);
  const caption = (t, s = '') => p.eval(`document.querySelector('#cap').innerHTML = ${JSON.stringify(t ? `${t}${s ? `<small>${s}</small>` : ''}` : '')}`);
  const shot = async () => {
    const s = await p.send('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
    await writeFile(path.join(OUT, `frame_${String(++n).padStart(5, '0')}.jpg`), Buffer.from(s.data, 'base64'));
    if (n % 30 === 0) console.log('frame', n);
  };

  // ---- A: the globe, from a street to past the Moon (11 s)
  const FA = 11 * FPS;
  for (let i = 0; i < FA; i++) {
    const u = i / (FA - 1), h = logLerp(900, 3.3e8, Math.pow(u, 1.35)), pitch = -Math.min(90, lerp(18, 90, Math.min(1, Math.log(h / 900) / Math.log(4e6 / 900))));
    const back = h < 2e6 ? (h / Math.tan(-pitch * Math.PI / 180)) / 111e3 * 0.6 : 0;   // stand south of the target while low
    await p.eval(`(() => { OO3D.time.setJd(window.__T0 + ${i / FPS / 86400}, 0); const C = Cesium;
      OO3D.viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(${LON}, ${LAT - back}, ${h}), orientation: { heading: 0, pitch: C.Math.toRadians(${pitch}), roll: 0 } }); })()`);
    if (i === 0) await caption('Live aircraft over ' + CITY, 'positions from public ADS-B feeds');
    if (i === 150) await caption('Every satellite we can track', '18,000+ objects · SGP4, live');
    if (i === 270) await caption('');
    await p.eval(`new Promise(r => { const t0 = performance.now(); const f = () => (OO3D.viewer.scene.globe.tilesLoaded && performance.now() - t0 > 60) || performance.now() - t0 > ${i < 60 ? 2500 : 900} ? r() : requestAnimationFrame(f); f(); })`);
    await shot();
  }
  // ---- the hand-off (the globe gives its camera to the Solar System view past the Moon)
  await p.poll(`document.querySelector('iframe')?.style.opacity === '1'`, { timeoutMs: 20000 }).catch(() => console.log('hand-off did not happen'));
  for (let i = 0; i < 12; i++) { await sleep(70); await shot(); }   // the 0.7 s cross-fade in real time
  // ---- B: the Solar System view, driven frame by frame
  await p.eval(`(() => { const S = document.querySelector('iframe').contentWindow.OOSS; window.__S = S;
    S.controls.enableDamping = false; S.nav.fly = null; window.__focus = { key: 'capture', name: '', radius: 0, pos: S.controls.target.clone() }; S.nav.focus = window.__focus;
    window.__dir = S.camera.position.clone().sub(S.controls.target).normalize(); window.__jd0 = S.clock.jd; S.clock.setRate(0);
    window.__place = (tx, ty, tz, d, dir) => { const T = S.THREE, t = new T.Vector3(tx, ty, tz); window.__focus.pos.copy(t); S.controls.target.copy(t); S.camera.position.copy(t).addScaledVector(dir, d); S.controls.update(); };
    window.__frames = n => new Promise(r => { let k = 0; const f = () => ++k >= n ? r() : requestAnimationFrame(f); requestAnimationFrame(f); });
  })()`);
  const solar = async (js, frames = 3) => { await p.eval(`(() => { const S = window.__S, T = S.THREE; ${js} })()`); await p.eval(`window.__frames(${frames})`); };
  const LY = 63241.077, earth = await p.eval(`window.__S.byKey.earth.pos.toArray()`);
  const trap = await p.eval(`window.__S.byKey['exo:TRAPPIST-1'].pos.toArray()`);
  // B1: Earth out to 30 light-years, the target sliding from Earth to the Sun, the view tilting to 28 deg above the ecliptic (9 s)
  const FB = 9 * FPS;
  for (let i = 0; i < FB; i++) {
    const u = ease(i / (FB - 1)), d = logLerp(0.0022, 30 * LY, u), w = Math.min(1, Math.max(0, (Math.log(d) - Math.log(0.05)) / (Math.log(3) - Math.log(0.05))));
    const tilt = lerp(0, 1, Math.min(1, u * 1.6));
    await solar(`const e = new T.Vector3(${earth}), d0 = window.__dir.clone(), d1 = new T.Vector3(0.55, -0.62, 0.56).normalize(), dir = d0.lerp(d1, ${tilt}).normalize();
      S.clock.setJd(window.__jd0 + ${i / FPS / 86400}); const tg = e.multiplyScalar(${1 - w}); window.__place(tg.x, tg.y, tg.z, ${d}, dir);`, i < 3 ? 6 : 2);
    if (i === 60) await caption('The planets, right now', 'JPL orbits · checked against NASA in the tests');
    if (i === 120) await caption('1.57 million asteroids', 'every one on its own orbit, on the GPU');
    if (i === 185) await caption('Our radio bubble', 'everything we have broadcast since 1920');
    if (i === 250) await caption('');
    await shot();
  }
  // B2: 40 light-years to TRAPPIST-1 and into its system (4 s), its planets orbiting (2.5 s)
  const FC = 4 * FPS, FD = 75;
  for (let i = 0; i < FC; i++) {
    const u = ease(i / (FC - 1)), d = logLerp(30 * LY, 0.16, u), tw = Math.min(1, u * 1.15);
    await solar(`const t = new T.Vector3(${trap}).multiplyScalar(${tw}); window.__place(t.x, t.y, t.z, ${d}, new T.Vector3(0.55, -0.62, 0.56).normalize());`, i > FC - 10 ? 6 : 2);
    if (i === 40) await caption('Another solar system', 'TRAPPIST-1 · 40 light-years · NASA Exoplanet Archive');
    await shot();
  }
  for (let i = 0; i < FD; i++) {
    await solar(`S.clock.setJd(window.__jd0 + ${i * 0.045}); const t = new T.Vector3(${trap}); window.__place(t.x, t.y, t.z, ${logLerp(0.16, 0.13, i / FD)}, new T.Vector3(0.55, -0.62, ${0.56 + i * 0.002}).normalize());`, 2);
    if (i === 30) await caption('Seven Earth-sized worlds', 'three in the habitable zone · real orbital speeds');
    await shot();
  }
  // B3: out to the cosmic web (4.5 s) and hold (2 s)
  const FE = Math.round(4.5 * FPS);
  for (let i = 0; i < FE; i++) {
    const u = ease(i / (FE - 1)), d = logLerp(0.13, 1.2e9 * LY, u), tw = 1 - Math.min(1, u * 3);
    await solar(`const t = new T.Vector3(${trap}).multiplyScalar(${tw}); window.__place(t.x, t.y, t.z, ${d}, new T.Vector3(0.55, -0.62, ${lerp(0.71, 0.4, u)}).normalize());`, i > FE - 30 ? 4 : 2);
    if (i === 0) await caption('');
    if (i === 70) await caption('43,480 galaxies', 'the cosmic web, out to 2 billion light-years');
    await shot();
  }
  for (let i = 0; i < 60; i++) {
    const a = i * 0.004;
    await solar(`window.__place(0, 0, 0, ${1.2e9 * LY}, new T.Vector3(${0.55 * Math.cos(a) + 0.62 * Math.sin(a)}, ${0.55 * Math.sin(a) - 0.62 * Math.cos(a)}, 0.4).normalize());`, 2);
    if (i === 15) await caption('Open Overwatch', 'everything, where it really is · runs in your browser');
    await shot();
  }
  console.log('done', n, 'frames ->', OUT);
} finally { await b.close(); }
