// Spherical-Earth geodesy for things that move across the map (aircraft dead reckoning, ship tracks).

export const EARTH_RADIUS_M = 6371000;
const R2D = 180 / Math.PI, D2R = Math.PI / 180;

/** Point reached from (lat, lon) after `dist` metres along initial bearing `bearing` (degrees), on a great circle. */
export function destination(lat, lon, dist, bearing) {
  const d = dist / EARTH_RADIUS_M, th = bearing * D2R, p1 = lat * D2R, l1 = lon * D2R;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(th));
  const l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 * R2D, lon: ((l2 * R2D + 540) % 360) - 180 };
}

/** Great-circle distance in metres (haversine). */
export function haversine(lat1, lon1, lat2, lon2) {
  const dp = (lat2 - lat1) * D2R, dl = (lon2 - lon1) * D2R;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Where a moving object is `seconds` after its last fix, flying straight along its track at ground speed `gs` (m/s).
 * Stationary or slow (< 15 m/s, taxiing) objects and those without a track stay put.
 */
export function deadReckon({ lat, lon, gs, track, ground }, seconds) {
  if (ground || !(gs > 15) || track == null || !(seconds > 0)) return { lat, lon };
  return destination(lat, lon, gs * seconds, track);
}
