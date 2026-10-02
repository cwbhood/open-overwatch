// Two-body orbits. Elements: { a (AU), e, i, node, peri (radians), M0 (rad at epoch), epoch (jd) }.

import { DEG, setXYZ } from './units.js';

export const TWO_PI = 2 * Math.PI;
export const GAUSS_DEG_PER_DAY = 0.9856076686;    // mean motion at a = 1 AU, from the Gaussian constant

export const wrap2pi = x => ((x % TWO_PI) + TWO_PI) % TWO_PI;
/** Mean motion in radians per day. */
export const meanMotion = a => GAUSS_DEG_PER_DAY * DEG / Math.pow(a, 1.5);

/**
 * Eccentric anomaly E for mean anomaly M (rad) and eccentricity e < 1, by Newton's method. Starting at pi for
 * e >= 0.8 keeps it convergent up to e -> 1 (the same scheme the GPU shader uses).
 */
export function solveKepler(M, e, tol = 1e-12) {
  M = wrap2pi(M);
  let E = e < 0.8 ? M + e * Math.sin(M) : Math.PI;
  for (let k = 0; k < 50; k++) {
    const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < tol) break;
  }
  return E;
}

/** Position on the orbit at eccentric anomaly E, heliocentric ecliptic. */
export function orbitPoint(el, E, out = {}) {
  const { a, e, i, node, peri } = el;
  const xv = a * (Math.cos(E) - e), yv = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cO = Math.cos(node), sO = Math.sin(node), cw = Math.cos(peri), sw = Math.sin(peri), ci = Math.cos(i), si = Math.sin(i);
  return setXYZ(out,
    (cO * cw - sO * sw * ci) * xv + (-cO * sw - sO * cw * ci) * yv,
    (sO * cw + cO * sw * ci) * xv + (-sO * sw + cO * cw * ci) * yv,
    sw * si * xv + cw * si * yv);
}

/** Position at time jd for elements with M0 at epoch. */
export function positionAt(el, jd, out = {}) {
  return orbitPoint(el, solveKepler(el.M0 + meanMotion(el.a) * (jd - el.epoch), el.e), out);
}

/** The whole ellipse as a flat Float32Array of n points (x, y, z, ...), evenly spaced in E. */
export function orbitPath(el, n = 720) {
  const pts = new Float32Array(n * 3), p = {};
  for (let k = 0; k < n; k++) { orbitPoint(el, k / n * TWO_PI, p); pts[k * 3] = p.x; pts[k * 3 + 1] = p.y; pts[k * 3 + 2] = p.z; }
  return pts;
}

/** Orbital period in days. */
export const periodDays = a => TWO_PI / meanMotion(a);
