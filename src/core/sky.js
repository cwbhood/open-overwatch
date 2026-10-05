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

/** The dark part of the next 24 h: { start, end } (Sun below -6 deg, civil dusk), or null in polar day. */
export function darkWindow(lat, lon, t0, step = 5 * 60e3) {
  let start = null;
  for (let t = t0; t <= t0 + 24 * 3600e3; t += step) {
    const dark = sunAlt(lat, lon, t) < -6;
    if (dark && start == null) start = t;
    if (!dark && start != null) return { start, end: t };
  }
  return start != null ? { start, end: t0 + 24 * 3600e3 } : null;
}

// the five bright planets, brightest first (Uranus and Neptune need binoculars and a chart)
const NAKED = [['venus', 'Venus'], ['jupiter', 'Jupiter'], ['mars', 'Mars'], ['saturn', 'Saturn'], ['mercury', 'Mercury']];

/**
 * Bright planets in the dark part of the next 24 h. Each: { key, name, up: bool, from, to, best, alt, az, text }.
 * time(ms) -> string formats a time for the sentence (default: UTC). A planet counts when it is 8 deg up in a dark sky.
 */
export function planetsTonight(lat, lon, t0, { time = utcTime, step = 10 * 60e3 } = {}) {
  const win = darkWindow(lat, lon, t0);
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
