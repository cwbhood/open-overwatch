// "Will it be clear tonight?" from an Open-Meteo hourly forecast (open-meteo.com, CC BY 4.0, free, no key):
// { hourly: { time: [unix s], cloud_cover: [%], precipitation_probability: [%] } }. DOM-free.

const HOUR = 3600e3;

/** Hourly rows [{ t (ms), cloud, rain }] from an Open-Meteo response (timeformat=unixtime). */
export function hoursOf(d) {
  const h = d && d.hourly; if (!h || !Array.isArray(h.time)) return [];
  return h.time.map((t, i) => ({ t: t * 1000, cloud: +h.cloud_cover?.[i], rain: +(h.precipitation_probability?.[i] ?? 0) })).filter(r => Number.isFinite(r.cloud));
}

/** Cloud cover (%) at ms: the hour it falls in (null outside the forecast). */
export function cloudAt(hours, ms) {
  const r = hours.find(x => ms >= x.t && ms < x.t + HOUR);
  return r ? r.cloud : null;
}

/** A word for a cloud cover. */
export const sky = c => c == null ? '' : c < 20 ? 'clear' : c < 45 ? 'mostly clear' : c < 75 ? 'partly cloudy' : c < 90 ? 'mostly cloudy' : 'overcast';

/**
 * The dark hours from start to end (ms) in words, and the clear stretches (cloud < 35% for 2 hours or more).
 * time(ms) -> string. Returns { mean, clear: [{ from, to }], text } or null if the forecast doesn't cover it.
 */
export function night(hours, start, end, { time = ms => new Date(ms).toISOString().slice(11, 16) } = {}) {
  const rows = hours.filter(r => r.t + HOUR > start && r.t < end);
  if (rows.length < Math.min(3, (end - start) / HOUR)) return null;
  const mean = Math.round(rows.reduce((a, r) => a + r.cloud, 0) / rows.length), rain = Math.max(...rows.map(r => r.rain || 0));
  const clear = []; let cur = null;
  for (const r of rows) {
    if (r.cloud < 35) { if (!cur) cur = { from: Math.max(r.t, start), to: Math.min(r.t + HOUR, end) }; else cur.to = Math.min(r.t + HOUR, end); }
    else if (cur) { clear.push(cur); cur = null; }
  }
  if (cur) clear.push(cur);
  const good = clear.filter(c => c.to - c.from >= 2 * HOUR), whole = good.length === 1 && good[0].to - good[0].from >= (end - start) - 1.5 * HOUR;
  let text;
  if (whole) text = mean < 15 ? 'Clear all night: a great night to look up.' : 'Mostly clear all night.';
  else if (good.length) {
    const rest = rows.filter(r => !good.some(c => r.t + HOUR > c.from && r.t < c.to)), rm = rest.length ? rest.reduce((a, r) => a + r.cloud, 0) / rest.length : mean;
    text = 'Clear ' + good.map(c => `${time(c.from)} to ${time(c.to)}`).join(' and ') + `, ${sky(rm)} the rest of the night.`;
  }
  else if (mean >= 75) text = `Cloudy all night (${mean}% cloud)${rain >= 50 ? ', with rain likely' : ''}.`;
  else text = `Patchy cloud (${mean}% on average): gaps come and go.`;
  return { mean, clear: good, rain, text };
}
