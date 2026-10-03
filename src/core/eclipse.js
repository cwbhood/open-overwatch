// Solar eclipse geometry: the Moon's shadow cones and where they meet the Earth, and how much of the Sun is covered
// from a given place. Everything in one Earth-centred frame in km; for places on the ground that frame must be the
// Earth-fixed one (the globe converts Horizons' ICRF vectors with Cesium's ICRF -> fixed rotation). DOM-free.

export const R_SUN = 695700, R_MOON = 1737.4;
export const WGS84 = { a: 6378.137, b: 6356.7523142 };
const sub = (p, q) => ({ x: p.x - q.x, y: p.y - q.y, z: p.z - q.z }), dot = (p, q) => p.x * q.x + p.y * q.y + p.z * q.z;
const len = p => Math.sqrt(dot(p, p)), scale = (p, k) => ({ x: p.x * k, y: p.y * k, z: p.z * k }), add = (p, q) => ({ x: p.x + q.x, y: p.y + q.y, z: p.z + q.z });
const unit = p => scale(p, 1 / len(p));

/** First intersection of the ray p + t d (t >= 0, d unit) with the ellipsoid, or null. */
export function rayEllipsoid(p, d, e = WGS84) {
  const ia = 1 / e.a, ib = 1 / e.b;
  const P = { x: p.x * ia, y: p.y * ia, z: p.z * ib }, Dv = { x: d.x * ia, y: d.y * ia, z: d.z * ib };
  const A = dot(Dv, Dv), B = 2 * dot(P, Dv), Cc = dot(P, P) - 1, disc = B * B - 4 * A * Cc;
  if (disc < 0) return null;
  const t = (-B - Math.sqrt(disc)) / (2 * A);
  return t >= 0 ? add(p, scale(d, t)) : null;
}

/** Shadow cones: axis (unit, Sun -> Moon), tan of the umbra / penumbra half-angles, umbra length behind the Moon. */
export function cones(sun, moon) {
  const v = sub(moon, sun), L = len(v), axis = scale(v, 1 / L);
  const f2 = Math.asin((R_SUN - R_MOON) / L), f1 = Math.asin((R_SUN + R_MOON) / L);
  return { axis, tu: Math.tan(f2), tp: Math.tan(f1), umbraLen: R_MOON / Math.sin(f2), penumbraR0: R_MOON / Math.cos(f1) };
}
/** Shadow radii (km, across the axis) at distance x behind the Moon; umbra < 0 means the antumbra (annular). */
export const radiiAt = (c, x) => ({ umbra: (c.umbraLen - x) * c.tu, penumbra: c.penumbraR0 + x * c.tp });

/**
 * Where the shadow axis meets the Earth at this moment: { center (km, on the ellipsoid) | null, x, umbra, penumbra,
 * kind: 'total' | 'annular' | null, miss (km from Earth's centre to the axis) }.
 */
export function shadowCenter(sun, moon, e = WGS84) {
  const c = cones(sun, moon), center = rayEllipsoid(moon, c.axis, e);
  const tNear = -dot(moon, c.axis), miss = len(add(moon, scale(c.axis, tNear)));
  if (!center) return { center: null, miss, ...radiiAt(c, Math.max(tNear, 0)), kind: null, cones: c };
  const x = dot(sub(center, moon), c.axis), r = radiiAt(c, x);
  return { center, x, miss, ...r, kind: r.umbra > 0 ? 'total' : 'annular', cones: c };
}

/** Outline of a shadow on the ground: n points (km) where rays along the axis at radius r around it hit the Earth. */
export function outline(sun, moon, which = 'umbra', n = 64, e = WGS84) {
  const s = shadowCenter(sun, moon, e), c = s.cones, x = s.center ? s.x : Math.max(-dot(moon, c.axis), 0);
  const r = Math.abs(radiiAt(c, x)[which]);
  const ref = Math.abs(c.axis.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const u = unit({ x: c.axis.y * ref.z - c.axis.z * ref.y, y: c.axis.z * ref.x - c.axis.x * ref.z, z: c.axis.x * ref.y - c.axis.y * ref.x });
  const w = { x: c.axis.y * u.z - c.axis.z * u.y, y: c.axis.z * u.x - c.axis.x * u.z, z: c.axis.x * u.y - c.axis.y * u.x };
  const pts = [];
  for (let k = 0; k < n; k++) {
    const t = k / n * 2 * Math.PI, start = add(moon, add(scale(u, Math.cos(t) * r), scale(w, Math.sin(t) * r)));
    const hit = rayEllipsoid(start, c.axis, e); if (hit) pts.push(hit);
  }
  return pts;
}

/** Overlap area of two circles (radii a, b, centres d apart) as a fraction of the first (the Sun). */
export function overlapFraction(a, b, d) {
  if (d >= a + b) return 0;
  if (d <= Math.abs(a - b)) return b >= a ? 1 : (b * b) / (a * a);
  const ca = Math.acos(Math.max(-1, Math.min(1, (d * d + a * a - b * b) / (2 * d * a)))), cb = Math.acos(Math.max(-1, Math.min(1, (d * d + b * b - a * a) / (2 * d * b))));
  const area = a * a * ca + b * b * cb - 0.5 * Math.sqrt(Math.max(0, (-d + a + b) * (d + a - b) * (d - a + b) * (d + a + b)));
  return area / (Math.PI * a * a);
}

/** What an observer at `obs` (km, same frame) sees: Sun and Moon angular radii, separation, covered fraction, kind. */
export function seenFrom(sun, moon, obs) {
  const s = sub(sun, obs), m = sub(moon, obs), ds = len(s), dm = len(m);
  const rs = Math.asin(R_SUN / ds), rm = Math.asin(R_MOON / dm), sep = Math.acos(Math.max(-1, Math.min(1, dot(s, m) / (ds * dm))));
  const covered = overlapFraction(rs, rm, sep);
  const kind = sep >= rs + rm ? 'none' : sep <= rm - rs ? 'total' : sep <= rs - rm ? 'annular' : 'partial';
  const sunUp = dot(s, unit(obs)) > 0;   // above the (spherical) horizon
  return { rs, rm, sep, covered, kind, sunUp };
}

/** Linear interpolation in a minute table: rows[i] = [x, y, z]; t in minutes from the first row. */
export function interp(rows, t) {
  const i = Math.max(0, Math.min(rows.length - 2, Math.floor(t))), f = Math.max(0, Math.min(1, t - i)), a = rows[i], b = rows[i + 1];
  return { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, z: a[2] + (b[2] - a[2]) * f };
}
