// Major moons (data/solar/moons.json, made by brand/tools/make_moons.py): planet-centred ecliptic J2000 orbits fitted to
// JPL Horizons over 2026, with linear rates for the mean longitude, the node and the periapsis. Good to about a degree
// for a few years around 2026 and drifting slowly beyond (see test/moons.test.mjs); short-period perturbations are left out.

import { DEG, KM_AU, setXYZ } from './units.js';
import { solveKepler, orbitPoint } from './kepler.js';

/** Planet-centred position of moon `m` (one entry of moons.json) at jd, ecliptic J2000, in AU. */
export function moonOffset(m, jd, out = {}) {
  const dt = jd - m.epoch_jd;
  const node = m.node + m.node_rate * dt, varpi = m.varpi + m.varpi_rate * dt, lambda = m.lambda + m.n * dt;
  const p = orbitPoint({ a: m.a_km, e: m.e, i: m.i * DEG, node: node * DEG, peri: (varpi - node) * DEG }, solveKepler((lambda - varpi) * DEG, m.e));
  return setXYZ(out, p.x * KM_AU, p.y * KM_AU, p.z * KM_AU);
}

/** Orbital period in days (sidereal, from the fitted mean motion). */
export const moonPeriod = m => 360 / m.n;
