// Units, constants and reference frames shared by every view.
// Space frame everywhere: heliocentric ecliptic J2000 (x -> March equinox, z -> ecliptic north pole), in AU.

export const AU_KM = 149597870.7;
export const KM_AU = 1 / AU_KM;
export const LY_AU = 63241.077;          // light-year in AU
export const PC_AU = 206264.806;         // parsec in AU
export const C_KM_S = 299792.458;
export const C_AU_DAY = C_KM_S * 86400 / AU_KM;
export const DEG = Math.PI / 180;
export const OBLIQUITY_J2000 = 23.4392911 * DEG;

const CE = Math.cos(OBLIQUITY_J2000), SE = Math.sin(OBLIQUITY_J2000);

export function setXYZ(out, x, y, z) { out.x = x; out.y = y; out.z = z; return out; }

/** Equatorial (ICRF/J2000) -> ecliptic J2000. */
export function eqToEcl(x, y, z, out = {}) { return setXYZ(out, x, y * CE + z * SE, -y * SE + z * CE); }
/** Ecliptic J2000 -> equatorial (ICRF/J2000). */
export function eclToEq(x, y, z, out = {}) { return setXYZ(out, x, y * CE - z * SE, y * SE + z * CE); }

/** Unit vector toward right ascension / declination (degrees), in the ecliptic frame. */
export function radecToEcl(raDeg, decDeg, out = {}) {
  const a = raDeg * DEG, d = decDeg * DEG;
  return eqToEcl(Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d), out);
}

// ICRS -> galactic rotation (rows are the galactic axes in equatorial coordinates), from the Hipparcos catalogue.
const EQ_TO_GAL = [
  [-0.0548755604, -0.8734370902, -0.4838350155],   // x: toward the galactic centre (l = 0, b = 0)
  [0.4941094279, -0.4448296300, 0.7469822445],     // y: l = 90 deg
  [-0.8676661490, -0.1980763734, 0.4559837762],    // z: north galactic pole
];
/** Galactic axes as unit vectors in the ecliptic frame. */
export const GALACTIC = Object.freeze({
  x: Object.freeze(eqToEcl(...EQ_TO_GAL[0])), y: Object.freeze(eqToEcl(...EQ_TO_GAL[1])), z: Object.freeze(eqToEcl(...EQ_TO_GAL[2])),
});
export const SUN_TO_GALACTIC_CENTRE_LY = 26000;
