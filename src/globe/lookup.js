// Look-up mode: stand where you are and look at the real sky. The camera sits at your location; on a phone it follows
// the phone's motion sensors (point it at the sky), elsewhere you drag to look around. Everything is in its true place
// already (the star map in ICRF axes, satellites from SGP4, aircraft, the Sun and Moon); this adds the planets, the
// brightest star names, a compass ring, labels for what is overhead and the next ISS pass. The ground is a plain dark
// sphere (no map tiles), and your location never leaves the page.
import { C, $, esc, fmt, toast, PHONE } from './env.js';
import { viewer, scene, camera, globe, ctrl, satPts } from './viewer.js';
import { state, hooks } from './state.js';
import { Earth, sunDirection } from './earth.js';
import { Sats } from './satellites.js';
import { Air } from './aircraft.js';
import { release } from './follow.js';
import { Time } from './time.js';
import { L } from './layers.js';
import { findPasses, lookAngles, compass } from '../core/passes.js';
import { planetPosition, earthPosition } from '../core/planets.js';
import { eclToEq } from '../core/units.js';
import { jdFromMs } from '../core/time.js';
import { deviceVectors, alphaFromCompass, azEl } from '../core/orientation.js';
import { activeShowers } from '../core/meteors.js';
import { fetchAsset } from '../core/assets.js';

const D = Math.PI / 180, FAR = 1.0e9;   // planets and stars are drawn 1 million km out: beyond every satellite
const FALLBACK = { lat: 51.4769, lon: -0.0005, name: 'Greenwich (allow location to see your own sky)' };
// the brightest stars (J2000 RA, Dec in degrees)
const STARS = [['Sirius', 101.287, -16.716], ['Canopus', 95.988, -52.696], ['Arcturus', 213.915, 19.182], ['Vega', 279.234, 38.784], ['Capella', 79.172, 45.998],
  ['Rigel', 78.634, -8.202], ['Procyon', 114.825, 5.225], ['Betelgeuse', 88.793, 7.407], ['Achernar', 24.429, -57.237], ['Hadar', 210.956, -60.373],
  ['Altair', 297.696, 8.868], ['Acrux', 186.650, -63.099], ['Aldebaran', 68.980, 16.509], ['Antares', 247.352, -26.432], ['Spica', 201.298, -11.161],
  ['Pollux', 116.329, 28.026], ['Fomalhaut', 344.413, -29.622], ['Deneb', 310.358, 45.280], ['Regulus', 152.093, 11.967], ['Polaris', 37.955, 89.264]];
const PLANETS = [['mercury', 'Mercury', '#d9c7b0'], ['venus', 'Venus', '#fff1c9'], ['mars', 'Mars', '#ff8a5c'], ['jupiter', 'Jupiter', '#f2dcb4'], ['saturn', 'Saturn', '#f0d9a0'], ['uranus', 'Uranus', '#b8f0f5'], ['neptune', 'Neptune', '#8fa8ff']];

// constellation stick figures (data/constellations.json, from d3-celestial: brand/tools/make_constellations.py). Drawn once in
// ICRF axes around the origin; each second their modelMatrix turns them with the Earth and centres them on you.
const CON = { data: null, lines: null, names: null, on: true };
async function constellations() {
  if (!CON.data) CON.data = await fetchAsset('data/constellations.json', 'json').catch(e => { console.warn('constellations', e); return { figures: [] }; });
  if (!S.active || CON.lines) return;
  const col = C.Color.fromCssColorString('#6f8fb8').withAlpha(0.55), mat = C.Material.fromType('Color', { color: col });
  CON.lines = scene.primitives.add(new C.PolylineCollection()); CON.names = scene.primitives.add(new C.LabelCollection());
  for (const f of CON.data.figures) {
    for (const l of f.l) { const pos = []; for (let i = 0; i < l.length; i += 2) pos.push(C.Cartesian3.multiplyByScalar(radec(l[i], l[i + 1]), FAR, new C.Cartesian3())); if (pos.length > 1) CON.lines.add({ positions: pos, width: 1.3, material: mat }); }
    if (f.rank <= 2) CON.names.add({ position: C.Cartesian3.multiplyByScalar(radec(f.c[0], f.c[1]), FAR, new C.Cartesian3()), text: f.name.toUpperCase(), font: `600 ${f.rank === 1 ? 11 : 10}px system-ui`, fillColor: C.Color.fromCssColorString('#8fa6c4').withAlpha(f.rank === 1 ? 0.85 : 0.6), horizontalOrigin: C.HorizontalOrigin.CENTER });
  }
  placeConstellations();
}
function placeConstellations() {
  if (!CON.lines || !S.obs) return;
  const M = icrfToFixed(viewer.clock.currentTime), m = C.Matrix4.fromRotationTranslation(M, S.obs.pos, new C.Matrix4());
  CON.lines.modelMatrix = m; CON.names.modelMatrix = m; CON.lines.show = CON.names.show = CON.on;
}
function dropConstellations() { for (const c of [CON.lines, CON.names]) if (c) scene.primitives.remove(c); CON.lines = CON.names = null; }

const S = { active: false, obs: null, saved: null, labels: null, points: null, ring: null, sensor: false, dir: null, up: null, heading: 180, pitch: 25, fov: 65, timer: 0, pass: null, onDown: null };

export function observerAt(lat, lon) {
  const pos = C.Cartesian3.fromDegrees(lon, lat, 2), m = C.Transforms.eastNorthUpToFixedFrame(pos);
  const E = new C.Cartesian3(m[0], m[1], m[2]), N = new C.Cartesian3(m[4], m[5], m[6]), U = new C.Cartesian3(m[8], m[9], m[10]);
  return { lat, lon, pos, E, N, U, km: { pos: { x: pos.x / 1000, y: pos.y / 1000, z: pos.z / 1000 }, east: E, north: N, up: U } };
}
const enuToFixed = (e, n, u, out = new C.Cartesian3()) => {
  const o = S.obs; out.x = o.E.x * e + o.N.x * n + o.U.x * u; out.y = o.E.y * e + o.N.y * n + o.U.y * u; out.z = o.E.z * e + o.N.z * n + o.U.z * u; return out;
};
const icrfToFixed = time => C.Transforms.computeIcrfToFixedMatrix(time) || C.Transforms.computeTemeToPseudoFixedMatrix(time);
const far = (dirFixed, out = new C.Cartesian3()) => C.Cartesian3.add(S.obs.pos, C.Cartesian3.multiplyByScalar(dirFixed, FAR, out), out);
const radec = (ra, dec) => new C.Cartesian3(Math.cos(dec * D) * Math.cos(ra * D), Math.cos(dec * D) * Math.sin(ra * D), Math.sin(dec * D));

function onOrientation(e) {
  let alpha = e.alpha;
  if (e.webkitCompassHeading != null) alpha = alphaFromCompass(e.webkitCompassHeading);   // iOS: alpha is relative, the compass is not
  else if (!e.absolute && e.type !== 'deviceorientationabsolute') return;       // a relative alpha would point the sky the wrong way
  if (alpha == null || e.beta == null) return;
  const v = deviceVectors(alpha, e.beta, e.gamma || 0, (screen.orientation && screen.orientation.angle) || window.orientation || 0), k = S.dir ? 0.25 : 1;   // smooth the sensor jitter
  S.dir = S.dir ? S.dir.map((x, i) => x + (v.dir[i] - x) * k) : v.dir; S.up = S.up ? S.up.map((x, i) => x + (v.up[i] - x) * k) : v.up;
  S.sensor = true;
}

// ---- per frame: the camera
function frame() {
  if (!S.active) return;
  let d, u;
  if (S.sensor && S.dir) { d = S.dir; u = S.up; }
  else {   // drag mode: heading (from north, clockwise) and pitch
    const h = S.heading * D, p = S.pitch * D;
    d = [Math.sin(h) * Math.cos(p), Math.cos(h) * Math.cos(p), Math.sin(p)]; u = [-Math.sin(h) * Math.sin(p), -Math.cos(h) * Math.sin(p), Math.cos(p)];
  }
  const dir = C.Cartesian3.normalize(enuToFixed(d[0], d[1], d[2]), new C.Cartesian3()), up = C.Cartesian3.normalize(enuToFixed(u[0], u[1], u[2]), new C.Cartesian3());
  camera.setView({ destination: S.obs.pos, orientation: { direction: dir, up } });
  const { az, el } = azEl(d);
  $('#luDir').textContent = `${compass(az)} ${Math.round(az)}° · ${el >= 0 ? 'up' : 'down'} ${Math.abs(Math.round(el))}°`;
}

// ---- once a second: planets, star names, what is overhead
function refresh() {
  if (!S.active) return;
  const time = viewer.clock.currentTime, M = icrfToFixed(time), jd = jdFromMs(Time.nowMs()), o = S.obs, labs = S.labels, pts = S.points;
  labs.removeAll(); pts.removeAll();
  const add = (pos, text, color, size = 7, font = '600 14px system-ui') => {
    pts.add({ position: pos, pixelSize: size, color: C.Color.fromCssColorString(color) });
    labs.add({ position: pos, text, font, fillColor: C.Color.fromCssColorString(color), pixelOffset: new C.Cartesian2(10, -8), showBackground: true, backgroundColor: C.Color.fromCssColorString('#05080caa'), horizontalOrigin: C.HorizontalOrigin.LEFT });
  };
  placeConstellations();
  const E = earthPosition(jd, {});
  for (const [key, name, col] of PLANETS) {
    const p = planetPosition(key, jd, {}), q = eclToEq(p.x - E.x, p.y - E.y, p.z - E.z), v = C.Cartesian3.normalize(new C.Cartesian3(q.x, q.y, q.z), new C.Cartesian3());
    add(far(C.Matrix3.multiplyByVector(M, v, new C.Cartesian3())), name, col, 8);
  }
  for (const m of activeShowers(Time.nowMs())) add(far(C.Matrix3.multiplyByVector(M, radec(m.ra, m.dec), new C.Cartesian3())), `☄ ${m.name} radiant`, '#ffb44d', 6, '600 12px system-ui');   // meteors seem to fly out of here
  for (const [name, ra, dec] of STARS) labs.add({ position: far(C.Matrix3.multiplyByVector(M, radec(ra, dec), new C.Cartesian3())), text: name, font: '500 12px system-ui', fillColor: C.Color.fromCssColorString('#cfd8e3'), pixelOffset: new C.Cartesian2(8, -6), horizontalOrigin: C.HorizontalOrigin.LEFT });
  // satellites above the horizon: count all, label the brightest ones. Not far from today: orbits from this week's
  // elements drift by kilometres a day, and nothing tells us what was up in 1990
  const away = Math.abs(Time.nowMs() - Date.now()) / 86400e3;
  satPts.show = away < 3;
  let above = 0; const bright = [];
  if (away < 3) for (const s of Sats.list) {
    if (!s.pt || !s.pt.position || s.docked) continue;
    const p = s.pt.position, a = lookAngles({ x: p.x / 1000, y: p.y / 1000, z: p.z / 1000 }, o.km);
    if (a.el < 0 || C.Cartesian3.magnitude(p) < 6.3e6) continue;
    above++; if ((s.layer === 'stations' || s.layer === 'visual') && a.el > 8) bright.push([a.el, s, p]);
  }
  bright.sort((x, y) => y[0] - x[0]);
  for (const [, s, p] of bright.slice(0, 10)) add(p, s.name, s.layer === 'stations' ? '#7dffa6' : '#e6edf3', s.layer === 'stations' ? 8 : 5, '600 12px system-ui');
  // aircraft within ~120 km and above the horizon
  let planes = 0;
  for (const r of Time.offLive() ? [] : Air.map.values()) {   // aircraft are live only
    if (!r.cur || r.ground) continue;
    const p = C.Cartesian3.fromDegrees(r.cur.lon, r.cur.lat, r.alt || 0), a = lookAngles({ x: p.x / 1000, y: p.y / 1000, z: p.z / 1000 }, o.km);
    if (a.el < 3 || a.range > 120) continue;
    planes++; if (planes <= 12) labs.add({ position: p, text: `✈ ${r.flight || r.hex} · ${fmt((r.alt || 0) / 0.3048)} ft`, font: '600 12px system-ui', fillColor: C.Color.fromCssColorString(r.mil ? '#ffb44d' : '#5fd3ff'), pixelOffset: new C.Cartesian2(10, 10), horizontalOrigin: C.HorizontalOrigin.LEFT, showBackground: true, backgroundColor: C.Color.fromCssColorString('#05080caa') });
  }
  $('#luNow').textContent = away < 3 ? `Above you ${Time.offLive() ? 'then' : 'now'}: ${fmt(above)} satellites${planes ? ` · ${planes} aircraft nearby` : ''}`
    : `The sky on ${new Date(Time.nowMs()).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}: planets, Moon and stars where they were (satellites only near today)`;
  $('#luPass').style.display = Time.offLive() ? 'none' : '';
}

// ---- the next ISS pass (recomputed every 10 minutes)
function nextPass() {
  const iss = Sats.byId.get('25544');
  if (!iss || !window.satellite) { $('#luPass').textContent = 'Next ISS pass: waiting for the orbit data…'; return; }
  const rec = iss.rec || (iss.rec = satellite.twoline2satrec(iss.l1, iss.l2));
  const at = ms => { const d = new Date(ms), pv = satellite.propagate(rec, d); if (!pv.position) return null; const f = satellite.eciToEcf(pv.position, satellite.gstime(d)); return { x: f.x, y: f.y, z: f.z }; };
  const sunAt = ms => sunDirection(C.JulianDate.fromDate(new Date(ms)));
  const now = Date.now(), passes = findPasses(at, S.obs.km, now, now + 48 * 3600e3, { step: 30e3, sunAt });
  const p = passes.find(x => x.visible) || passes[0];
  if (!p) { $('#luPass').textContent = 'No ISS pass above 10° in the next 48 hours from here.'; return; }
  const t = new Date(p.rise), when = t.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }), mins = Math.round((p.set - p.rise) / 60e3);
  $('#luPass').innerHTML = `<b>Next ISS pass:</b> ${esc(when)} · ${mins} min · up to ${Math.round(p.maxEl)}° · ${compass(p.azRise)} → ${compass(p.azSet)}${p.visible ? ' · <span class="ok">visible to the eye</span>' : p.visible === false ? ' · in daylight or Earth\'s shadow' : ''}`;
}

// ---- enter / leave
async function enter() {
  if (S.active) return;
  // iOS asks for motion permission, and only from inside a tap: ask first, before anything awaits
  let motionOk = true;
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try { motionOk = (await DeviceOrientationEvent.requestPermission()) === 'granted'; } catch (e) { motionOk = false; }
  }
  release(); Time.goLive();
  S.saved = { pos: C.Cartesian3.clone(camera.positionWC), dir: C.Cartesian3.clone(camera.directionWC), up: C.Cartesian3.clone(camera.upWC), fov: camera.frustum.fov,
    inputs: ctrl.enableInputs, base: C.Color.clone(globe.baseColor), dock: $('#dock').classList.contains('open') };
  $('#lookup').classList.add('on'); document.body.classList.add('lookup'); $('#luWhere').textContent = 'Finding where you are…';
  const loc = await new Promise(res => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(p => res(p.coords), () => res(null), { timeout: 9000, maximumAge: 600e3 });
  });
  S.obs = loc ? observerAt(loc.latitude, loc.longitude) : observerAt(FALLBACK.lat, FALLBACK.lon);
  $('#luWhere').textContent = loc ? `Your sky · ${loc.latitude.toFixed(2)}, ${loc.longitude.toFixed(2)} (stays on this device)` : FALLBACK.name;
  S.active = true; state.lookup = true; S.sensor = false; S.dir = S.up = null;
  Earth.hidden = true; Earth.apply(); globe.baseColor = C.Color.fromCssColorString('#0b0f14');
  ctrl.enableInputs = false; camera.frustum.fov = S.fov * D;
  S.labels = scene.primitives.add(new C.LabelCollection()); S.points = scene.primitives.add(new C.PointPrimitiveCollection());
  // compass ring on the horizon
  S.ring = new C.LabelCollection(); scene.primitives.add(S.ring);
  for (let az = 0; az < 360; az += 45) {
    const p = C.Cartesian3.add(S.obs.pos, C.Cartesian3.multiplyByScalar(enuToFixed(Math.sin(az * D), Math.cos(az * D), 0.02), 3e4, new C.Cartesian3()), new C.Cartesian3());
    S.ring.add({ position: p, text: compass(az), font: az % 90 ? '600 13px system-ui' : '800 17px system-ui', fillColor: C.Color.fromCssColorString(az === 0 ? '#ff6b6b' : '#e6edf3'), horizontalOrigin: C.HorizontalOrigin.CENTER });
  }
  if (motionOk) { addEventListener('deviceorientationabsolute', onOrientation); addEventListener('deviceorientation', onOrientation); }
  $('#luHint').textContent = PHONE && motionOk ? 'Hold your phone up to the sky. (No movement? Drag to look around.)' : 'Drag to look around · scroll or pinch to zoom';
  // drag / zoom when there are no sensors (or as an override)
  const cv = scene.canvas; let last = null;
  S.onDown = e => { last = [e.clientX, e.clientY]; S.sensor = false; };
  S.onMove = e => { if (!last) return; S.heading = (S.heading - (e.clientX - last[0]) * S.fov / innerHeight + 360) % 360; S.pitch = Math.max(-80, Math.min(89, S.pitch + (e.clientY - last[1]) * S.fov / innerHeight)); last = [e.clientX, e.clientY]; };
  S.onUp = () => { last = null; };
  S.onWheel = e => { S.fov = Math.max(10, Math.min(100, S.fov * (e.deltaY > 0 ? 1.08 : 0.93))); camera.frustum.fov = S.fov * D; };
  cv.addEventListener('pointerdown', S.onDown); addEventListener('pointermove', S.onMove); addEventListener('pointerup', S.onUp); cv.addEventListener('wheel', S.onWheel, { passive: true });
  scene.preRender.addEventListener(frame);
  const dateBox = $('#luDate'), local = ms => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60e3); return d.toISOString().slice(0, 16); };
  dateBox.value = local(Date.now());
  dateBox.onchange = () => { const ms = new Date(dateBox.value).getTime(); if (Number.isFinite(ms)) { Time.setJd(jdFromMs(ms), 0); refresh(); } };   // paused at that moment
  $('#luLive').onclick = () => { Time.goLive(); dateBox.value = local(Date.now()); refresh(); };
  const red = on => { document.documentElement.classList.toggle('redlight', on); $('#luRed').classList.toggle('on', on); try { localStorage.setItem('oo3d.red', on ? '1' : ''); } catch (e) { /* private mode */ } };
  red((() => { try { return localStorage.getItem('oo3d.red') === '1'; } catch (e) { return false; } })());   // dark-adapted eyes: remembered
  $('#luRed').onclick = () => red(!document.documentElement.classList.contains('redlight'));
  $('#luCon').classList.toggle('on', CON.on);
  $('#luCon').onclick = () => { CON.on = !CON.on; $('#luCon').classList.toggle('on', CON.on); placeConstellations(); };
  refresh(); S.timer = setInterval(refresh, 1000); nextPass(); S.passTimer = setInterval(nextPass, 600e3); constellations();
}

function leave() {
  if (!S.active) return;
  S.active = false; state.lookup = false; clearInterval(S.timer); clearInterval(S.passTimer); if (!Time.live) Time.goLive(); else hooks.applyVisibility();
  removeEventListener('deviceorientationabsolute', onOrientation); removeEventListener('deviceorientation', onOrientation);
  const cv = scene.canvas; cv.removeEventListener('pointerdown', S.onDown); removeEventListener('pointermove', S.onMove); removeEventListener('pointerup', S.onUp); cv.removeEventListener('wheel', S.onWheel);
  scene.preRender.removeEventListener(frame);
  for (const c of [S.labels, S.points, S.ring]) scene.primitives.remove(c);
  dropConstellations(); document.documentElement.classList.remove('redlight');
  Earth.hidden = false; globe.baseColor = S.saved.base; ctrl.enableInputs = S.saved.inputs; camera.frustum.fov = S.saved.fov;
  camera.setView({ destination: S.saved.pos, orientation: { direction: S.saved.dir, up: S.saved.up } });
  $('#lookup').classList.remove('on'); document.body.classList.remove('lookup');
}

export const LookUp = { enter, leave, get active() { return S.active; }, state: S };
