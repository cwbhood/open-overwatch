// Accuracy against JPL Horizons, measured with the same code the views run. Used by the tests (thresholds) and by the
// "Under the hood" panel, which loads the same reference file and measures the errors live in the browser.
import { planetPosition, earthPosition, moonGeocentric } from './planets.js';
import { moonOffset } from './moons.js';
import { AU_KM, DEG } from './units.js';

const len = v => Math.hypot(v.x, v.y, v.z), vec = a => ({ x: a[0], y: a[1], z: a[2] });
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y + a.z * b.z) / (len(a) * len(b))))) / DEG;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const NAMES = { mercury: 'Mercury', venus: 'Venus', mars: 'Mars', jupiter: 'Jupiter', saturn: 'Saturn', neptune: 'Neptune' };

/**
 * H: test/fixtures/horizons_*.json; moons: data/solar/moons.json's list. Returns rows
 * { name, what, deg (angular error), km (position error) } for the planets (seen from the Sun), Earth's centre,
 * the Moon (seen from Earth's centre) and the major moons (seen from their planet).
 */
export function measureAgainstHorizons(H, moons = []) {
  const jd = H.jd_tt, rows = [];
  for (const [k, name] of Object.entries(NAMES)) {
    if (!H.bodies[k]) continue;
    const p = planetPosition(k, jd), r = vec(H.bodies[k]);
    rows.push({ name, what: 'heliocentric', deg: angle(p, r), km: dist(p, r) * AU_KM });
  }
  if (H.bodies.earth_center) { const p = earthPosition(jd), r = vec(H.bodies.earth_center); rows.push({ name: 'Earth', what: 'heliocentric (centre)', deg: angle(p, r), km: dist(p, r) * AU_KM }); }
  if (H.moon_geo) { const p = moonGeocentric(jd), r = vec(H.moon_geo); rows.push({ name: 'Moon', what: 'geocentric', deg: angle(p, r), km: dist(p, r) * AU_KM }); }
  for (const [name, ref] of Object.entries(H.moons || {})) {
    const m = moons.find(x => x.name === name); if (!m) continue;
    const p = moonOffset(m, jd), q = { x: p.x * AU_KM, y: p.y * AU_KM, z: p.z * AU_KM }, r = vec(ref);
    rows.push({ name, what: 'around its planet', deg: angle(q, r), km: dist(q, r) });
  }
  return rows;
}
