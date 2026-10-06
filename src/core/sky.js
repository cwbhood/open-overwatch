// Your sky tonight, in plain words: where the Sun, Moon and planets are for an observer on the ground, the Moon's phase,
// which planets are worth stepping outside for, the aurora chance at your spot (from NOAA's OVATION grid), satellite
// passes as a sentence, and which Starlink launches are still flying as a "train". DOM-free; times are ms since 1970.
// Accuracy is "where to look" (a degree or so): RA/Dec are J2000 against the mean sidereal time of date.
import { DEG, eclToEq } from './units.js';
import { jdFromMs } from './time.js';
import { planetPosition, earthPosition, moonGeocentric } from './planets.js';
import { compass } from './passes.js';

/** Greenwich mean sidereal time, degrees. */
export const gmst = jd => (((280.46061837 + 360.98564736629 * (jd - 2451545)) % 360) + 360) % 360;

/** Equatorial RA/Dec (deg) of an ecliptic J2000 vector seen from Earth's centre. */
function raDec(x, y, z) {
  const q = eclToEq(x, y, z), r = Math.hypot(q.x, q.y, q.z);
  return { ra: ((Math.atan2(q.y, q.x) / DEG) + 360) % 360, dec: Math.asin(q.z / r) / DEG };
}

/** Geocentric RA/Dec of 'sun', 'moon' or a planet key at jd. */
export function bodyRaDec(key, jd) {
  if (key === 'moon') { const m = moonGeocentric(jd); return raDec(m.x, m.y, m.z); }
  const E = earthPosition(jd);
  if (key === 'sun') return raDec(-E.x, -E.y, -E.z);
  const p = planetPosition(key, jd); return raDec(p.x - E.x, p.y - E.y, p.z - E.z);
}

/** Altitude and azimuth (deg, azimuth from north through east) of RA/Dec for an observer at lat/lon (deg) at jd. */
export function altAz({ ra, dec }, lat, lon, jd) {
  const H = (gmst(jd) + lon - ra) * DEG, d = dec * DEG, f = lat * DEG;
  const alt = Math.asin(Math.sin(f) * Math.sin(d) + Math.cos(f) * Math.cos(d) * Math.cos(H));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(f) - Math.tan(d) * Math.cos(f)) / DEG + 180;
  return { alt: alt / DEG, az: (az + 360) % 360 };
}

export const sunAlt = (lat, lon, ms) => altAz(bodyRaDec('sun', jdFromMs(ms)), lat, lon, jdFromMs(ms)).alt;

/** The Moon: fraction lit (0-1), waxing or waning, and a name for the phase. */
export function moonPhase(ms) {
  const jd = jdFromMs(ms), m = moonGeocentric(jd), E = earthPosition(jd);
  const lm = Math.atan2(m.y, m.x), ls = Math.atan2(-E.y, -E.x);
  const el = Math.acos(Math.max(-1, Math.min(1, (m.x * -E.x + m.y * -E.y + m.z * -E.z) / (Math.hypot(m.x, m.y, m.z) * Math.hypot(E.x, E.y, E.z)))));
  const lit = (1 - Math.cos(el)) / 2, waxing = ((lm - ls) / DEG + 360) % 360 < 180;
  const name = lit < 0.03 ? 'New Moon' : lit > 0.97 ? 'Full Moon' : lit < 0.45 ? (waxing ? 'Waxing crescent' : 'Waning crescent')
    : lit <= 0.55 ? (waxing ? 'First quarter' : 'Last quarter') : (waxing ? 'Waxing gibbous' : 'Waning gibbous');
  return { lit, waxing, name };
}

const where = alt => alt >= 60 ? 'high up' : alt >= 30 ? 'halfway up' : 'low';
const utcTime = ms => new Date(ms).toISOString().slice(11, 16) + ' UTC';

/**
 * The dark part of the next 24 h: { start, end } (Sun below -6 deg, civil dusk), or null in polar day. A stretch already
 * under way at t0 that ends within `minLeft` ms (the last minutes before dawn) is skipped for the coming night.
 */
export function darkWindow(lat, lon, t0, opts = {}) {
  const { step = 5 * 60e3, minLeft = 0 } = typeof opts === 'number' ? { step: opts } : opts;
  let start = null, skipped = false;
  for (let t = t0; t <= t0 + 30 * 3600e3; t += step) {
    const dark = sunAlt(lat, lon, t) < -6;
    if (dark && start == null) start = t;
    if (!dark && start != null) {
      if (start === t0 && t - t0 < minLeft && !skipped) { start = null; skipped = true; continue; }   // the tail of last night: wait for tonight
      return { start, end: t };
    }
    if (t >= t0 + 24 * 3600e3 && (start == null || !skipped)) break;
  }
  return start != null ? { start, end: Math.max(start + step, t0 + 24 * 3600e3) } : null;
}

// the five bright planets, brightest first (Uranus and Neptune need binoculars and a chart)
const NAKED = [['venus', 'Venus'], ['jupiter', 'Jupiter'], ['mars', 'Mars'], ['saturn', 'Saturn'], ['mercury', 'Mercury']];

/**
 * Bright planets in the dark part of the next 24 h. Each: { key, name, up: bool, from, to, best, alt, az, text }.
 * time(ms) -> string formats a time for the sentence (default: UTC). A planet counts when it is 8 deg up in a dark sky.
 */
export function planetsTonight(lat, lon, t0, { time = utcTime, step = 10 * 60e3, minLeft = 0 } = {}) {
  const win = darkWindow(lat, lon, t0, { minLeft });
  return NAKED.map(([key, name]) => {
    if (!win) return { key, name, up: false, text: `${name}: no dark sky here in the next day` };
    let from = null, to = null, best = null, bestAlt = -90, bestAz = 0;
    for (let t = win.start; t <= win.end; t += step) {
      const jd = jdFromMs(t), a = altAz(bodyRaDec(key, jd), lat, lon, jd);
      if (a.alt < 8) continue;
      if (from == null) from = t; to = t;
      if (a.alt > bestAlt) { bestAlt = a.alt; bestAz = a.az; best = t; }
    }
    if (from == null) return { key, name, up: false, text: `${name}: not up while it's dark` };
    const mid = (win.start + win.end) / 2, dir = compass(bestAz);
    let text;
    if (from - win.start < 20 * 60e3 && to < mid) text = `${name}: ${where(bestAlt)} in the ${dir} after dusk, until about ${time(to)}`;
    else if (win.end - to < 20 * 60e3 && from > mid) text = `${name}: ${where(bestAlt)} in the ${dir} before dawn, from about ${time(from)}`;
    else text = `${name}: up ${time(from)} to ${time(to)}, highest in the ${dir} around ${time(best)} (${Math.round(bestAlt)}°)`;
    return { key, name, up: true, from, to, best, alt: bestAlt, az: bestAz, text };
  });
}

/**
 * Aurora chance near lat/lon from OVATION coordinates [[lon 0-359, lat, percent], ...]: overhead (the cell you're under)
 * and on the horizon (the strongest cell up to 9 deg poleward, ~1,000 km: aurora 110 km up is visible that far away, low down).
 */
export function auroraAt(coords, lat, lon) {
  const L = ((Math.round(lon) % 360) + 360) % 360, la = Math.round(lat), pole = lat >= 0 ? 1 : -1;
  let overhead = 0, horizon = 0;
  for (const [x, y, p] of coords) {
    const dl = Math.min(Math.abs(x - L), 360 - Math.abs(x - L));
    if (dl === 0 && y === la) overhead = p;
    const k = (y - la) * pole;
    if (dl <= 4 && k >= 0 && k <= 9 && p > horizon) horizon = p;
  }
  const side = pole > 0 ? 'northern' : 'southern';
  const level = overhead >= 30 ? 3 : overhead >= 10 || horizon >= 30 ? 2 : horizon >= 10 ? 1 : 0;
  const text = ['Aurora unlikely from here right now.', `Aurora possible low on the ${side} horizon (a camera sees it best).`,
    overhead >= 10 ? 'Aurora possible overhead: get away from city lights.' : `Aurora likely on the ${side} horizon: get away from city lights.`,
    'Aurora likely overhead right now: go outside and look up!'][level];
  return { overhead, horizon, level, text };
}

/** A pass ({ rise, set, maxEl, azRise, azSet, visible }) as a sentence. time(ms) -> string. */
export function describePass(name, p, { time = utcTime } = {}) {
  const high = p.maxEl >= 60 ? 'nearly overhead' : p.maxEl >= 30 ? 'high' : 'low';
  const mins = Math.max(1, Math.round((p.set - p.rise) / 60e3));
  return `${name} at ${time(p.rise)}: look ${compass(p.azRise)}, it climbs ${high} (${Math.round(p.maxEl)}°) and sets in the ${compass(p.azSet)} · ${mins} min${p.visible ? ' · bright, easy to see' : ''}`;
}

/**
 * Starlink launches still flying low as a "train" (just after launch they climb from ~300 km in a bright line).
 * tles: [{ id, name, l1, l2 }]. Returns one representative per launch with at least `min` satellites below ~470 km
 * (mean motion over 15.3 revs/day), newest launch first: [{ launch: '2026-123', count, sat }].
 */
export function starlinkTrains(tles, { min = 5 } = {}) {
  const groups = new Map();
  for (const t of tles) {
    if (!/STARLINK/i.test(t.name || '')) continue;
    const n = parseFloat(t.l2.slice(52, 63)), launch = t.l1.slice(9, 14).trim();
    if (!(n > 15.3) || !/^\d{5}$/.test(launch)) continue;
    (groups.get(launch) || groups.set(launch, []).get(launch)).push(t);
  }
  return [...groups].filter(([, g]) => g.length >= min)
    .map(([k, g]) => { const yy = +k.slice(0, 2); return { launch: `${yy < 57 ? 2000 + yy : 1900 + yy}-${k.slice(2)}`, count: g.length, sat: g[Math.floor(g.length / 2)] }; })
    .sort((a, b) => b.launch.localeCompare(a.launch));
}

/**
 * When a body crosses altitude h0 (deg) in the next `hours`: { rise, set } (ms, either may be null), plus up: true/false if
 * it never crosses (always up / always down). Sun h0 -0.833 (refraction + the disc's edge), Moon +0.125 (its parallax),
 * civil twilight -6, astronomical darkness -18.
 */
export function riseSet(key, lat, lon, t0, { h0 = -0.833, hours = 24, step = 10 * 60e3 } = {}) {
  const alt = t => { const jd = jdFromMs(t); return altAz(bodyRaDec(key, jd), lat, lon, jd).alt - h0; };
  const edge = (a, b) => { let fa = alt(a); for (let k = 0; k < 24 && b - a > 20e3; k++) { const m = (a + b) / 2, fm = alt(m); if ((fm > 0) === (fa > 0)) { a = m; fa = fm; } else b = m; } return Math.round((a + b) / 2); };
  let rise = null, set = null, prev = alt(t0), tp = t0;
  const up0 = prev > 0;
  for (let t = t0 + step; t <= t0 + hours * 3600e3 && (rise == null || set == null); t += step) {
    const cur = alt(t);
    if (prev <= 0 && cur > 0 && rise == null) rise = edge(tp, t);
    if (prev > 0 && cur <= 0 && set == null) set = edge(tp, t);
    prev = cur; tp = t;
  }
  return { rise, set, up: rise == null && set == null ? up0 : null };
}

const SYNODIC = 29.530589 * 86400e3;
/** Full Moon names (the one nearest the September equinox is the Harvest Moon, the next the Hunter's Moon). */
const MONTH_MOON = ['Wolf', 'Snow', 'Worm', 'Pink', 'Flower', 'Strawberry', 'Buck', 'Sturgeon', 'Corn', "Hunter's", 'Beaver', 'Cold'];
const elong = t => { const jd = jdFromMs(t), m = moonGeocentric(jd), E = earthPosition(jd); return ((Math.atan2(m.y, m.x) - Math.atan2(-E.y, -E.x)) / DEG + 720) % 360; };
/** The instant of the first full Moon after ms (elongation grows ~12.2 deg a day; full when it passes 180). */
function fullAfter(ms) {
  let t = ms, e = elong(t);
  for (let i = 0; i < 40 * 4 && !(e < 180 && elong(t + 6 * 3600e3) >= 180); i++) { t += 6 * 3600e3; e = elong(t); }
  let a = t, b = t + 6 * 3600e3;
  for (let k = 0; k < 30; k++) { const m = (a + b) / 2; if (elong(m) < 180) a = m; else b = m; }
  return Math.round((a + b) / 2);
}
/** The next full Moon after ms: { at, name, km, supermoon }. */
export function nextFullMoon(ms) {
  const at = fullAfter(ms), d = new Date(at), eq = Date.UTC(d.getUTCFullYear(), 8, 22, 12);   // the September equinox, to a few hours
  // the real neighbouring full Moons (a mean month would be off by hours: two Moons nearly equidistant from the equinox could both be "Harvest")
  const prev = fullAfter(at - 1.5 * SYNODIC), next = fullAfter(at + 86400e3), prev2 = fullAfter(prev - 1.5 * SYNODIC), near = x => Math.abs(x - eq);
  let name = MONTH_MOON[d.getUTCMonth()] + ' Moon';
  if (near(at) < near(prev) && near(at) <= near(next)) name = 'Harvest Moon';
  else if (near(prev) < near(prev2) && near(prev) <= near(at) && at > eq) name = "Hunter's Moon";
  const m = moonGeocentric(jdFromMs(at)), km = Math.hypot(m.x, m.y, m.z) * 149597870.7;
  return { at, name, km: Math.round(km), supermoon: km < 362000 };
}

/** A spacecraft from data/solar/spacecraft.json ({ t0_jd, step_days, xyz: AU heliocentric ecliptic }) at jd: { x, y, z } or null before launch. */
export function craftAt(c, jd) {
  const f = (jd - c.t0_jd) / c.step_days, x = c.xyz, n = x.length / 3; if (f < 0 || n < 2) return null;
  const k = Math.min(Math.floor(f), n - 2), t = f - k;   // past the last sample it coasts on in a straight line
  return { x: x[k * 3] + (x[k * 3 + 3] - x[k * 3]) * t, y: x[k * 3 + 1] + (x[k * 3 + 4] - x[k * 3 + 1]) * t, z: x[k * 3 + 2] + (x[k * 3 + 5] - x[k * 3 + 2]) * t };
}

/** Angle (deg) between two RA/Dec directions. */
export function separation(a, b) {
  const r = DEG, c = Math.sin(a.dec * r) * Math.sin(b.dec * r) + Math.cos(a.dec * r) * Math.cos(b.dec * r) * Math.cos((a.ra - b.ra) * r);
  return Math.acos(Math.max(-1, Math.min(1, c))) / r;
}

const BRIGHT = [['venus', 'Venus'], ['jupiter', 'Jupiter'], ['mars', 'Mars'], ['saturn', 'Saturn'], ['mercury', 'Mercury']];
/**
 * Close meetings in the sky over the next `days`: the Moon within 5 deg of a bright planet, two planets within 3 deg.
 * Each: { at (ms, closest), a, b, sep (deg), elong (deg from the Sun: under ~15 it's lost in the glare) }, by time.
 */
export function meetings(ms, { days = 30 } = {}) {
  const out = [], bodies = [['moon', 'the Moon'], ...BRIGHT];
  const pos = t => { const jd = jdFromMs(t); return Object.fromEntries([...bodies.map(([k]) => [k, bodyRaDec(k, jd)]), ['sun', bodyRaDec('sun', jd)]]); };
  const step = 2 * 3600e3, n = Math.ceil(days * 86400e3 / step), P = [];
  for (let i = 0; i <= n; i++) P.push(pos(ms + i * step));
  for (let x = 0; x < bodies.length; x++) for (let y = x + 1; y < bodies.length; y++) {
    const [ka, na] = bodies[x], [kb, nb] = bodies[y], lim = ka === 'moon' ? 5 : 3;
    const sep = P.map(p => separation(p[ka], p[kb]));
    for (let i = 1; i < n; i++) if (sep[i] < lim && sep[i] <= sep[i - 1] && sep[i] < sep[i + 1]) {
      const p = P[i], elong = Math.min(separation(p.sun, p[ka]), separation(p.sun, p[kb]));
      out.push({ at: ms + i * step, a: na, b: nb, ka, kb, sep: sep[i], elong });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}
