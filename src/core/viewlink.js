// A shared view as a URL hash, and back. Pure functions (the globe's share.js reads and applies them):
//   #c=lon,lat,height,heading,pitch  &l=layer,ids,on  &w=ir,wind  &t=julianDate,rate  &k=ISO2  &f=CALLSIGN (a flight to find)
//   #go=tonight opens a panel by itself (no camera needed): see GO

const r = (v, n) => +Number(v).toFixed(n);
const FLIGHT = /^[A-Za-z0-9]{2,8}$/;
/** Panels a link may open on arrival (#go=...). Nothing that needs a tap first (look-up asks for motion sensors). */
export const GO = Object.freeze(['tonight', 'flight', 'search', 'launches', 'crew', 'eclipses', 'flybys', 'conj']);

/** The parts of a hash that work without a camera: { go: 'tonight' | null, flight: 'BAW123' | null }. */
export function decodeExtras(hash) {
  const p = new URLSearchParams(String(hash || '').replace(/^#/, '')), go = p.get('go'), f = p.get('f');
  return { go: GO.includes(go) ? go : null, flight: f && FLIGHT.test(f) ? f.toUpperCase() : null };
}

/** view: { lon, lat, height, heading, pitch (degrees, metres), layers: [ids], weather: [ids] | null, time: { jd, rate } | null, country: 'JP' | null } */
export function encodeView(v) {
  const p = new URLSearchParams();
  p.set('c', [r(v.lon, 4), r(v.lat, 4), Math.round(v.height), r(v.heading, 1), r(v.pitch, 1)].join(','));
  if (v.layers) p.set('l', v.layers.join(','));
  if (v.weather) p.set('w', v.weather.join(','));
  if (v.time) p.set('t', r(v.time.jd, 5) + ',' + v.time.rate);
  if (v.country) p.set('k', v.country);
  if (v.flight && FLIGHT.test(v.flight)) p.set('f', v.flight);
  return p.toString();
}

/** The view in a hash ('#c=...'), or null if it is not a usable link. Nothing here is trusted: numbers are checked, ids are limited. */
export function decodeView(hash) {
  if (!hash || hash.length < 4) return null;
  const p = new URLSearchParams(hash.replace(/^#/, '')), c = (p.get('c') || '').split(',').map(Number);
  if (c.length < 3 || c.slice(0, 3).some(x => !Number.isFinite(x)) || Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90 || c[2] < 0 || c[2] > 1e10) return null;
  const ids = s => (s || '').split(',').filter(x => /^[a-z0-9_-]{1,24}$/i.test(x)).slice(0, 60);
  const out = { lon: c[0], lat: c[1], height: c[2], heading: Number.isFinite(c[3]) ? c[3] : 0, pitch: Number.isFinite(c[4]) ? c[4] : -90, layers: p.has('l') ? ids(p.get('l')) : null, weather: p.has('w') ? ids(p.get('w')) : null, time: null, country: null };
  if (p.has('t')) { const [jd, rate] = p.get('t').split(',').map(Number); if (Number.isFinite(jd) && jd > 2000000 && jd < 3000000) out.time = { jd, rate: Number.isFinite(rate) ? rate : 1 }; }
  if (/^[A-Z]{2}$/.test(p.get('k') || '')) out.country = p.get('k');
  out.flight = decodeExtras(hash).flight;
  return out;
}
