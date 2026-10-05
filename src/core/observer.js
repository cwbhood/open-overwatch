// An observer on the WGS84 ellipsoid in Earth-fixed coordinates (km), and the Sun's direction in the same frame, without
// Cesium: what core/passes.js needs to find satellite passes on a page that has no 3D globe. DOM-free.
import { bodyRaDec, gmst } from './sky.js';
import { jdFromMs } from './time.js';

const A = 6378.137, F = 1 / 298.257223563, E2 = F * (2 - F), D = Math.PI / 180;

/** { pos, east, north, up } for geodetic lat/lon (deg) and height (km): Earth-fixed (ECEF), km and unit vectors. */
export function observer(lat, lon, h = 0) {
  const p = lat * D, l = lon * D, sp = Math.sin(p), cp = Math.cos(p), sl = Math.sin(l), cl = Math.cos(l), N = A / Math.sqrt(1 - E2 * sp * sp);
  return {
    pos: { x: (N + h) * cp * cl, y: (N + h) * cp * sl, z: (N * (1 - E2) + h) * sp },
    east: { x: -sl, y: cl, z: 0 }, north: { x: -sp * cl, y: -sp * sl, z: cp }, up: { x: cp * cl, y: cp * sl, z: sp },
  };
}

/** Unit vector from the Earth's centre toward the Sun, Earth-fixed, at ms (J2000 RA/Dec turned by sidereal time: ~0.4 deg). */
export function sunEcef(ms) {
  const jd = jdFromMs(ms), s = bodyRaDec('sun', jd), h = (s.ra - gmst(jd)) * D, d = s.dec * D;
  return { x: Math.cos(d) * Math.cos(h), y: Math.cos(d) * Math.sin(h), z: Math.sin(d) };
}
