// Planets from JPL's "approximate positions" elements (E. M. Standish, valid 1800-2050) and the Moon from Paul
// Schlyter's elements with the main perturbations. Heliocentric (Moon: geocentric) ecliptic J2000, AU.
// https://ssd.jpl.nasa.gov/planets/approx_pos.html · https://stjarnhimlen.se/comp/ppcomp.html

import { DEG, KM_AU, setXYZ } from './units.js';
import { solveKepler, orbitPoint, wrap2pi } from './kepler.js';
import { julianCenturies, J2000 } from './time.js';

// [a, e, I, L, long.peri, long.node] (au, -, deg) followed by their rates per Julian century. "earth" is the
// Earth-Moon barycentre, 4,700 km from Earth's centre: invisible at these scales.
const ELEMENTS = {
  mercury: [0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593, 0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081],
  venus: [0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255, 0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418],
  earth: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0, 0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0],
  mars: [1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891, 0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
  jupiter: [5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909, -0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106],
  saturn: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448, -0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794],
  uranus: [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503, -0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589],
  neptune: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574, 0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664],
};
export const PLANET_KEYS = Object.freeze(Object.keys(ELEMENTS));
export const VALID_JD = Object.freeze([2378496.5, 2469807.5]); // 1800-01-01 .. 2050-01-01

/** Physical data: mean radius (km) and polar flattening. */
export const PHYSICAL = Object.freeze({
  sun: { name: 'Sun', radiusKm: 695700, flattening: 0 },
  mercury: { name: 'Mercury', radiusKm: 2439.7, flattening: 0 },
  venus: { name: 'Venus', radiusKm: 6051.8, flattening: 0 },
  earth: { name: 'Earth', radiusKm: 6371.0, flattening: 0.003353 },
  moon: { name: 'Moon', radiusKm: 1737.4, flattening: 0.0012 },
  mars: { name: 'Mars', radiusKm: 3389.5, flattening: 0.00589 },
  jupiter: { name: 'Jupiter', radiusKm: 69911, flattening: 0.06487 },
  saturn: { name: 'Saturn', radiusKm: 58232, flattening: 0.09796, rings: { innerKm: 74500, outerKm: 140220 } },
  uranus: { name: 'Uranus', radiusKm: 25362, flattening: 0.02293 },
  neptune: { name: 'Neptune', radiusKm: 24622, flattening: 0.01708 },
});

/** Osculating-style elements at jd: { a, e, i, node, peri, M } (radians). */
export function planetElements(key, jd) {
  const p = ELEMENTS[key], t = julianCenturies(jd);
  const a = p[0] + p[6] * t, e = p[1] + p[7] * t, i = (p[2] + p[8] * t) * DEG;
  const L = p[3] + p[9] * t, varpi = p[4] + p[10] * t, node = (p[5] + p[11] * t) * DEG;
  return { a, e, i, node, peri: varpi * DEG - node, M: wrap2pi((L - varpi) * DEG) };
}

export function planetPosition(key, jd, out = {}) {
  const el = planetElements(key, jd);
  return orbitPoint(el, solveKepler(el.M, el.e), out);
}

/** Heliocentric ecliptic longitude of a planet (radians, 0..2pi). */
export function planetLongitude(key, jd) { const p = planetPosition(key, jd); return wrap2pi(Math.atan2(p.y, p.x)); }

/**
 * Smallest arc (degrees) that contains all eight planets as seen from the Sun; "alignment" = a small spread.
 * Planets never line up exactly; the tightest grouping in a century is typically 70-110 deg.
 */
export function planetSpread(jd) {
  const L = PLANET_KEYS.map(k => planetLongitude(k, jd) / DEG).sort((a, b) => a - b);
  let gap = 360 - L[L.length - 1] + L[0];
  for (let i = 1; i < L.length; i++) gap = Math.max(gap, L[i] - L[i - 1]);
  return 360 - gap;
}

/** Moon's share of the Earth-Moon mass: Earth's centre sits this fraction of the Moon's distance from the barycentre. */
export const MOON_MASS_FRACTION = 1 / (81.30056 + 1);

/** Heliocentric position of Earth's centre (not the Earth-Moon barycentre, which is ~4,700 km away from it). */
export function earthPosition(jd, out = {}) {
  const b = planetPosition('earth', jd), m = moonGeocentric(jd), k = MOON_MASS_FRACTION;
  out.x = b.x - k * m.x; out.y = b.y - k * m.y; out.z = b.z - k * m.z; return out;
}

/** Geocentric Moon (Schlyter's elements + the 10 largest longitude, 4 latitude and 2 distance terms), AU. */
export function moonGeocentric(jd, out = {}) {
  const d = jd - 2451543.5, r = DEG;
  const N = (125.1228 - 0.0529538083 * d) * r, i = 5.1454 * r, w = (318.0634 + 0.1643573223 * d) * r, e = 0.0549;
  const M = wrap2pi((115.3654 + 13.0649929509 * d) * r);
  const E = solveKepler(M, e), xv = 60.2666 * (Math.cos(E) - e), yv = 60.2666 * Math.sqrt(1 - e * e) * Math.sin(E);
  const v = Math.atan2(yv, xv);
  let dist = Math.hypot(xv, yv);
  let lon = Math.atan2(Math.sin(v + w) * Math.cos(i), Math.cos(v + w)) + N, lat = Math.asin(Math.sin(v + w) * Math.sin(i));
  const Ms = (356.0470 + 0.9856002585 * d) * r, Ls = Ms + (282.9404 + 4.70935e-5 * d) * r, Lm = N + w + M, D = Lm - Ls, F = Lm - N;
  lon += r * (-1.274 * Math.sin(M - 2 * D) + 0.658 * Math.sin(2 * D) - 0.186 * Math.sin(Ms) - 0.059 * Math.sin(2 * M - 2 * D)
    - 0.057 * Math.sin(M - 2 * D + Ms) + 0.053 * Math.sin(M + 2 * D) + 0.046 * Math.sin(2 * D - Ms) + 0.041 * Math.sin(M - Ms)
    - 0.035 * Math.sin(D) - 0.031 * Math.sin(M + Ms));
  lat += r * (-0.173 * Math.sin(F - 2 * D) - 0.055 * Math.sin(M - F - 2 * D) - 0.046 * Math.sin(M + F - 2 * D) + 0.033 * Math.sin(F + 2 * D));
  dist += -0.58 * Math.cos(M - 2 * D) - 0.46 * Math.cos(2 * D);
  lon -= 1.396971 * DEG * (jd - J2000) / 36525;   // Schlyter's angles are of date: undo general precession -> J2000
  const R = dist * 6378.14 * KM_AU; // Earth radii -> AU
  return setXYZ(out, R * Math.cos(lat) * Math.cos(lon), R * Math.cos(lat) * Math.sin(lon), R * Math.sin(lat));
}
