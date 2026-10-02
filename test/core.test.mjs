// Core maths, checked against JPL Horizons vectors (test/fixtures) and textbook identities.  Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEG, AU_KM, LY_AU, eqToEcl, eclToEq, radecToEcl, GALACTIC } from '../src/core/units.js';
import { J2000, jdFromMs, msFromJd, formatUtc, SimClock, REAL_TIME } from '../src/core/time.js';
import { solveKepler, orbitPoint, orbitPath, positionAt, periodDays } from '../src/core/kepler.js';
import { PLANET_KEYS, planetPosition, moonGeocentric, planetSpread } from '../src/core/planets.js';
import { bodyAxes, IAU_ROTATION } from '../src/core/rotation.js';
import { viewSmallBodies, decodeElements, cometElements, packSmallBodies } from '../src/core/smallbodies.js';
import { lightTime, distance, viewWidth, esc } from '../src/core/format.js';
import { fetchAsset } from '../src/core/assets.js';

const root = new URL('../', import.meta.url);
const H = JSON.parse(readFileSync(new URL('test/fixtures/horizons_2026-10-02.json', root)));
const len = v => Math.hypot(v.x, v.y, v.z);
const vec = a => ({ x: a[0], y: a[1], z: a[2] });
const angleDeg = (a, b) => Math.acos(Math.min(1, (a.x * b.x + a.y * b.y + a.z * b.z) / (len(a) * len(b)))) / DEG;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

test('time: J2000 and round trips', () => {
  assert.equal(jdFromMs(Date.UTC(2000, 0, 1, 12)), J2000);
  assert.ok(Math.abs(msFromJd(jdFromMs(1790909534893)) - 1790909534893) < 0.05);   // JD doubles resolve ~40 µs
  assert.equal(formatUtc(J2000), '2000-01-01 12:00 UTC');
});

test('time: SimClock follows the wall clock when live, accumulates otherwise, clamps', () => {
  let now = Date.UTC(2026, 9, 2);
  const c = new SimClock({ now: () => now });
  assert.ok(c.live);
  now += 3600e3; c.tick(0.016);
  assert.ok(Math.abs(c.jd - jdFromMs(now)) < 1e-9);
  c.setRate(30); c.tick(2);
  assert.ok(!c.live && Math.abs(c.jd - (jdFromMs(now) + 60)) < 1e-9);
  const d = new SimClock({ jd: 100, rate: -10, min: 95, now: () => now }); d.tick(1);
  assert.equal(d.jd, 95);
  assert.ok(new SimClock({ now: () => now }).setRate(REAL_TIME).live);
});

test('units: frames are rotations and the poles land where they should', () => {
  const v = eclToEq(...Object.values(eqToEcl(0.3, -0.5, 0.8)));
  assert.ok(dist(v, { x: 0.3, y: -0.5, z: 0.8 }) < 1e-12);
  const ncp = radecToEcl(0, 90);                         // celestial pole sits 23.44 deg from the ecliptic pole
  assert.ok(Math.abs(Math.asin(ncp.z) / DEG - 66.5607) < 1e-3);
  const gc = GALACTIC.x, eq = eclToEq(gc.x, gc.y, gc.z);  // galactic centre: RA 266.40, Dec -28.94
  assert.ok(Math.abs(((Math.atan2(eq.y, eq.x) / DEG) + 360) % 360 - 266.405) < 0.01);
  assert.ok(Math.abs(Math.asin(eq.z) / DEG + 28.936) < 0.01);
  for (const [a, b] of [['x', 'y'], ['y', 'z'], ['x', 'z']]) assert.ok(Math.abs(GALACTIC[a].x * GALACTIC[b].x + GALACTIC[a].y * GALACTIC[b].y + GALACTIC[a].z * GALACTIC[b].z) < 1e-8);
});

test("kepler: solves Kepler's equation for every eccentricity up to 0.999", () => {
  for (const e of [0, 0.01, 0.2, 0.5, 0.8, 0.95, 0.99, 0.999]) for (let M = -7; M <= 7; M += 0.37) {
    const E = solveKepler(M, e), Mw = ((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    assert.ok(Math.abs(E - e * Math.sin(E) - Mw) < 1e-10, `e=${e} M=${M}`);
  }
});

test('kepler: geometry and periods', () => {
  const el = { a: 2.5, e: 0.3, i: 0.4, node: 1.1, peri: 2.2 };
  for (let E = 0; E < 6.3; E += 0.5) assert.ok(Math.abs(len(orbitPoint(el, E)) - el.a * (1 - el.e * Math.cos(E))) < 1e-12);
  const p = orbitPath(el, 360); let rmin = Infinity, rmax = 0;
  for (let k = 0; k < 360; k++) { const r = Math.hypot(p[k * 3], p[k * 3 + 1], p[k * 3 + 2]); rmin = Math.min(rmin, r); rmax = Math.max(rmax, r); }
  assert.ok(Math.abs(rmin - 1.75) < 1e-5 && Math.abs(rmax - 3.25) < 1e-5);
  assert.ok(Math.abs(periodDays(1) - 365.2569) < 0.01);           // sidereal year
});

test('planets: within the formulae\'s stated accuracy of JPL Horizons (2026-10-02)', () => {
  const tolArcmin = { mercury: 1, venus: 1, earth: 1, mars: 2, jupiter: 12, saturn: 15, neptune: 2 };
  for (const [k, ref] of Object.entries({ ...H.bodies, earth: H.bodies.emb })) {
    if (k === 'emb') continue;
    const p = planetPosition(k, H.jd_tt), r = vec(ref);
    assert.ok(angleDeg(p, r) * 60 < tolArcmin[k], `${k}: ${(angleDeg(p, r) * 60).toFixed(2)}′`);
    assert.ok(Math.abs(len(p) / len(r) - 1) < 2e-3, `${k} distance`);
  }
  assert.deepEqual(PLANET_KEYS, ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']);
});

test('planets: the Moon within 0.2 deg and 0.5% of Horizons', () => {
  const m = moonGeocentric(H.jd_tt), r = vec(H.moon_geo);
  assert.ok(angleDeg(m, r) < 0.2, `${angleDeg(m, r).toFixed(3)} deg`);
  assert.ok(Math.abs(len(m) / len(r) - 1) < 5e-3);
});

test('planets: alignment spread is a sensible arc', () => {
  const s = planetSpread(H.jd_tt);
  assert.ok(s > 0 && s <= 360);
  assert.ok(planetSpread(2464703.5) < 130);                       // 2036-01-11: the tightest grouping this century
});

test('rotation: orthonormal axes; Earth\'s prime meridian follows the Earth Rotation Angle', () => {
  for (const k of Object.keys(IAU_ROTATION)) {
    const { x, y, z } = bodyAxes(k, H.jd_tt);
    for (const v of [x, y, z]) assert.ok(Math.abs(len(v) - 1) < 1e-12);
    assert.ok(Math.abs(x.x * y.x + x.y * y.y + x.z * y.z) < 1e-12 && Math.abs(len({ x: x.y * y.z - x.z * y.y, y: x.z * y.x - x.x * y.z, z: x.x * y.y - x.y * y.x }) - 1) < 1e-12);
  }
  const { x } = bodyAxes('earth', H.jd_tt), eq = eclToEq(x.x, x.y, x.z);
  // Greenwich in the J2000 frame = the IERS Earth Rotation Angle (GMST of date minus the accumulated precession in RA)
  const era = 360 * (0.7790572732640 + 1.00273781191135448 * (H.jd_tt - J2000));
  const diff = ((Math.atan2(eq.y, eq.x) / DEG - era) % 360 + 540) % 360 - 180;
  assert.ok(Math.abs(diff) < 0.01, `${diff.toFixed(4)} deg`);
});

test('small bodies: the packed data reproduces Horizons for Ceres and Vesta', () => {
  const meta = JSON.parse(readFileSync(new URL('data/solar/small_bodies.json', root)));
  const buf = readFileSync(new URL('data/solar/asteroids_a.bin', root));
  const view = viewSmallBodies(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const find = name => meta.named.find(n => n[2] === name);
  for (const [name, ref] of [['1 Ceres', [0.27086, 2.65868, 0.03427]], ['4 Vesta', [2.33577, 0.70258, -0.30528]]]) {
    const n = find(name); assert.equal(n[0], 'a');
    const p = positionAt(decodeElements(view, n[1], meta.epoch_jd), H.jd_tt);
    assert.ok(dist(p, vec(ref)) < 1e-3, `${name}: ${dist(p, vec(ref)).toFixed(5)} AU`);
  }
});

test('small bodies: pack/unpack round trip, comets', () => {
  const el = { a: 17.83, e: 0.967, i: 162.2 * DEG, node: 59.4 * DEG, peri: 112.2 * DEG, M0: 3.0 };
  const back = decodeElements(viewSmallBodies(packSmallBodies([el])), 0);
  assert.ok(Math.abs(back.a - el.a) < 1e-5 && Math.abs(back.e - el.e) < 1e-4 && Math.abs(back.M0 - el.M0) < 1e-4);
  assert.equal(cometElements(['C/2023 A3', 0.39, 1.0001, 139, 21, 308, 2460581]), null);    // hyperbolic: skipped
  const halley = cometElements(['1P/Halley', 0.5717, 0.96714, 162.19, 59.40, 112.24, 2446470.95]);
  assert.ok(Math.abs(halley.a - 17.4) < 0.1 && Math.abs(periodDays(halley.a) / 365.25 - 72.6) < 1);
});

test('format: readable distances and light times', () => {
  assert.equal(lightTime(1), '8 min 19 s');
  assert.equal(lightTime(4.2465 * LY_AU), '4.2 years');
  assert.equal(distance(384400 / AU_KM), '384,400 km');
  assert.equal(distance(4.24 * LY_AU), '4.24 light-years');
  assert.equal(viewWidth(150000 * LY_AU), '150,000 light-years');
  assert.equal(esc('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
});

test('assets: falls back to the site copy', async () => {
  const seen = [];
  const fake = async url => { seen.push(url); return url.startsWith('https://') ? { ok: true, json: async () => ({ ok: 1 }) } : { ok: false, status: 404 }; };
  assert.deepEqual(await fetchAsset('data/x.json', 'json', { fetchImpl: fake }), { ok: 1 });
  assert.equal(seen.length, 2);
  await assert.rejects(fetchAsset('data/y.bin', 'buffer', { fetchImpl: async () => ({ ok: false, status: 500 }) }), /could not load data\/y\.bin/);
});
