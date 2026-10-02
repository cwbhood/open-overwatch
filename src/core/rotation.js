// Body orientation from the IAU WGCCRE rotation models (main terms only): pole RA/Dec and prime meridian angle W.
// Body-fixed axes in the ecliptic frame: x = prime meridian on the equator (texture longitude 0), y = north pole,
// z = x × y, which puts east longitude 90 deg at -z (matching three.js SphereGeometry UVs).

import { DEG, eqToEcl, radecToEcl } from './units.js';
import { J2000 } from './time.js';

// [pole RA, pole Dec, W0, W per day, RA per century, Dec per century] in degrees (periodic terms omitted).
export const IAU_ROTATION = Object.freeze({
  sun: [286.13, 63.87, 84.176, 14.1844],
  mercury: [281.0103, 61.4155, 329.5988, 6.1385108, -0.0328, -0.0049],
  venus: [272.76, 67.16, 160.20, -1.4813688],
  // Earth: the IERS Earth Rotation Angle (ERA = 360 * (0.779057273264 + 1.00273781191135448 d), measured from RA 90
  // here) on the J2000 equator: Greenwich's direction in the J2000 frame. (The IAU's rounded W0 is ~0.3 deg off.)
  earth: [0, 90, 190.46061837504, 360.985612288088],
  moon: [269.9949, 66.5392, 38.3213, 13.17635815, 0.0031, 0.0130],
  mars: [317.269202, 54.432516, 176.049863, 350.891982443, -0.10927547, -0.05827105],
  jupiter: [268.056595, 64.495303, 284.95, 870.536, -0.006499, 0.002413],
  saturn: [40.589, 83.537, 38.90, 810.7939024, -0.036, -0.004],
  uranus: [257.311, -15.175, 203.81, -501.1600928],
  neptune: [299.36, 43.46, 249.978, 541.1397757],
  pluto: [132.993, -6.163, 302.695, -56.3625225],
});

/** Prime meridian angle W (radians) at jd. */
export function primeMeridian(key, jd) { const r = IAU_ROTATION[key]; return (r[2] + r[3] * (jd - J2000)) * DEG; }

/** Body-fixed axes { x, y, z } (unit vectors, ecliptic frame) at jd. */
export function bodyAxes(key, jd, out = { x: {}, y: {}, z: {} }) {
  const r = IAU_ROTATION[key], T = (jd - J2000) / 36525, ra = r[0] + (r[4] || 0) * T, dec = r[1] + (r[5] || 0) * T, W = primeMeridian(key, jd);
  const p = radecToEcl(ra, dec), n = eqToEcl(-Math.sin(ra * DEG), Math.cos(ra * DEG), 0);   // pole, ascending node
  const q = cross(p, n), c = Math.cos(W), s = Math.sin(W);
  const x = { x: n.x * c + q.x * s, y: n.y * c + q.y * s, z: n.z * c + q.z * s };
  Object.assign(out.x, x); Object.assign(out.y, p); Object.assign(out.z, cross(x, p));
  return out;
}

function cross(a, b) { return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }; }
