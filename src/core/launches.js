// Rocket launches from The Space Devs' Launch Library 2 (the site build keeps a trimmed copy in data/launches.json; a page
// without it asks the API directly). One mapping for both, so the build only trims and never reshapes. DOM-free.

const https = u => (typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/.test(u) ? u : null);
const num = v => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);

/** One LL2 launch (any response mode) -> { id, name, mission, type, desc, orbit, rocket, provider, net, windowStart, windowEnd,
 *  precision, status, statusName, pad, place, country, lat, lon, prob, live, webcasts: [{ url, title }] } or null without a pad. */
export function fromLL2(r) {
  if (!r || !r.pad) return null;
  const lat = num(r.pad.latitude), lon = num(r.pad.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const m = r.mission || {}, cfg = (r.rocket && r.rocket.configuration) || {}, t = s => (s ? Date.parse(s) : NaN);
  const vids = (r.vid_urls || []).slice().sort((a, b) => (b.priority || 0) - (a.priority || 0))
    .map(v => ({ url: https(v.url), title: String(v.title || v.publisher || 'Webcast').slice(0, 120) })).filter(v => v.url).slice(0, 3);
  return {
    id: String(r.id || ''), name: String(r.name || ''), mission: String(m.name || r.name || '').slice(0, 140), type: String(m.type || ''),
    desc: String(m.description || '').replace(/\s+/g, ' ').trim().slice(0, 600), orbit: (m.orbit && (m.orbit.name || m.orbit.abbrev)) || '',
    rocket: String(cfg.full_name || cfg.name || (r.name || '').split('|')[0]).trim(), provider: String((r.launch_service_provider && r.launch_service_provider.name) || ''),
    net: t(r.net), windowStart: t(r.window_start), windowEnd: t(r.window_end),
    precision: (r.net_precision && (r.net_precision.abbrev || r.net_precision.name)) || '', status: (r.status && r.status.abbrev) || '', statusName: (r.status && r.status.name) || '',
    pad: String(r.pad.name || ''), place: String((r.pad.location && r.pad.location.name) || ''), country: (r.pad.country && r.pad.country.alpha_2_code) || '',
    lat, lon, prob: Number.isFinite(num(r.probability)) ? num(r.probability) : null, live: !!r.webcast_live, webcasts: vids,
  };
}

/** How sure the time is, in words (LL2's precision codes). */
export function when(l, fmt = ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC') {
  const p = String(l.precision).toUpperCase();
  if (!Number.isFinite(l.net)) return 'Date not set';
  if (['SEC', 'MIN', 'HR', 'SECOND', 'MINUTE', 'HOUR'].includes(p) || !p) return fmt(l.net);
  const d = new Date(l.net);
  if (p === 'DAY') return d.toISOString().slice(0, 10) + ' (time not set)';
  if (p === 'M' || p === 'MONTH') return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }) + ' (no date yet)';
  if (/^Q[1-4]$/.test(p) || /^H[12]$/.test(p)) return `${p} ${d.getUTCFullYear()} (no date yet)`;
  return d.getUTCFullYear() + ' (no date yet)';
}

/** "T-2 d 04:10:22", "T-00:04:59", or "T+00:01:12" (counting up after lift-off). */
export function countdown(net, now) {
  if (!Number.isFinite(net)) return '';
  const s = Math.round((net - now) / 1000), a = Math.abs(s), d = Math.floor(a / 86400), h = Math.floor(a / 3600) % 24, m = Math.floor(a / 60) % 60, x = a % 60;
  const hms = [h, m, x].map(v => String(v).padStart(2, '0')).join(':');
  return `T${s >= 0 ? '-' : '+'}${d ? d + ' d ' : ''}${hms}`;
}

/** Upcoming first; a launch stays listed for 2 hours after its time (or while marked in flight). */
export function upcoming(list, now) {
  return list.filter(l => l && (l.status === 'In Flight' || !Number.isFinite(l.net) || l.net > now - 2 * 3600e3)).sort((a, b) => (a.net || Infinity) - (b.net || Infinity));
}
