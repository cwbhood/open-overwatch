// The major annual meteor showers (IMO working list: peak dates shift by a day at most between years, ZHR is the rate
// an observer would see with the radiant overhead under a perfect dark sky). For "tonight": which shower is active or
// coming up, how many you could really see from here (radiant height and the Moon cut the rate), and when to look.
// DOM-free.
import { jdFromMs } from './time.js';
import { altAz, moonPhase, darkWindow } from './sky.js';
import { compass } from './passes.js';

// [name, peak [month, day], active from [m, d], to [m, d], radiant RA, Dec (deg), ZHR, speed km/s, parent]
export const SHOWERS = Object.freeze([
  ['Quadrantids', [1, 3], [12, 28], [1, 12], 230, 49, 110, 41, 'asteroid 2003 EH1'],
  ['Lyrids', [4, 22], [4, 14], [4, 30], 271, 34, 18, 49, 'comet Thatcher'],
  ['Eta Aquariids', [5, 6], [4, 19], [5, 28], 338, -1, 50, 66, "Halley's Comet"],
  ['Southern Delta Aquariids', [7, 30], [7, 12], [8, 23], 340, -16, 25, 41, 'comet 96P/Machholz'],
  ['Perseids', [8, 12], [7, 17], [8, 24], 48, 58, 100, 59, 'comet Swift-Tuttle'],
  ['Draconids', [10, 8], [10, 6], [10, 10], 262, 54, 10, 20, 'comet Giacobini-Zinner'],
  ['Orionids', [10, 21], [10, 2], [11, 7], 95, 16, 20, 66, "Halley's Comet"],
  ['Leonids', [11, 17], [11, 6], [11, 30], 152, 22, 15, 71, 'comet Tempel-Tuttle'],
  ['Geminids', [12, 14], [12, 4], [12, 20], 112, 33, 150, 35, 'asteroid 3200 Phaethon'],
  ['Ursids', [12, 22], [12, 17], [12, 26], 217, 76, 10, 33, 'comet Tuttle'],
].map(([name, peak, from, to, ra, dec, zhr, kms, parent]) => ({ name, peak, from, to, ra, dec, zhr, kms, parent })));

const DAY = 86400e3;
/** The UTC date (ms, 00:00) of month/day in the year that makes it nearest to `ms`. */
function nearest([m, d], ms) {
  const y = new Date(ms).getUTCFullYear();
  return [y - 1, y, y + 1].map(Y => Date.UTC(Y, m - 1, d, 12)).sort((a, b) => Math.abs(a - ms) - Math.abs(b - ms))[0];   // noon: "peaks tonight" lands on the right night from Hawaii to Tokyo
}
/** Is ms inside the active window (which may wrap past New Year)? */
function active(s, ms) {
  const p = nearest(s.peak, ms), f = nearest(s.from, p), t = nearest(s.to, p);
  return ms >= Math.min(f, p) && ms <= Math.max(t, p) + DAY;
}

/**
 * Showers active now, or peaking within `ahead` days, for an observer at lat/lon. Each:
 * { name, peakMs, days (to the peak, <0 = past), nights (whole local nights to the peak night: 0 = tonight), active, zhr,
 *   rate (an honest per-hour estimate from here tonight, 0 if not active yet), ratePeak (the same on the peak night), bestMs,
 *   radiantAlt, dir, moonLit, text }. Sorted by peak. A published peak is a UT date, so it straddles two local nights
 *   everywhere: the night whose midnight falls within 18 h of the peak instant is "tonight" (both do, at Greenwich).
 */
export function showersFor(lat, lon, ms, { ahead = 21, time = t => new Date(t).toISOString().slice(11, 16) + ' UTC', minLeft = 0 } = {}) {
  const out = [];
  for (const s of SHOWERS) {
    const peakMs = nearest(s.peak, ms), days = (peakMs - ms) / DAY, on = active(s, ms);
    if (!on && !(days > 0 && days <= ahead)) continue;
    // the radiant through the coming night (or the peak night if that's ahead): highest while it's dark
    const night = darkWindow(lat, lon, on ? ms : Math.max(ms, peakMs - DAY / 2), { minLeft: on ? minLeft : 0 });
    let best = null, bestAlt = -90;
    if (night) for (let t = night.start; t <= night.end; t += 15 * 60e3) { const jd = jdFromMs(t), a = altAz(s, lat, lon, jd).alt; if (a > bestAlt) { bestAlt = a; best = t; } }
    const sinAlt = Math.max(0, Math.sin(bestAlt * Math.PI / 180)), moon = moonPhase(ms), moonPeak = moonPhase(peakMs);
    // 0.6: a suburban sky, not a perfect one. Rates fall away from the peak (a rough triangle over ~4 days each side)
    const ratePeak = Math.round(s.zhr * sinAlt * (1 - 0.6 * moonPeak.lit) * 0.6);
    const rate = on ? Math.round(ratePeak * Math.max(0.1, 1 - Math.min(1, Math.abs(days) / 4) * 0.9) * (1 - 0.6 * moon.lit) / (1 - 0.6 * moonPeak.lit)) : 0;
    const dir = best ? compass(altAz(s, lat, lon, jdFromMs(best)).az) : '';
    // local nights: each is named for the evening it starts; local solar midnight is at 00:00 UT - lon/15 h
    const nightOf = t => Math.floor((t + lon * 240e3 - DAY / 2) / DAY), midnightOf = n => (n + 1) * DAY - lon * 240e3;
    const tonightN = nightOf(ms); let nights = nightOf(peakMs) - tonightN;
    if (Math.abs(peakMs - midnightOf(tonightN)) <= 18 * 3600e3) nights = 0;
    const peakDay = nights === 0;
    const when = peakDay ? 'peaks tonight' : nights === 1 ? 'peaks tomorrow night' : nights > 1 ? `peaks in ${nights} nights` : nights === -1 ? 'peaked last night (still near its best)' : `peaked ${-nights} nights ago`;
    const howMany = peakDay ? `up to ~${Math.max(1, ratePeak)} an hour from here` : on && days > 0 ? `~${Math.max(1, rate)} an hour from here tonight, up to ~${Math.max(1, ratePeak)} on the peak night`
      : on ? `~${Math.max(1, rate)} an hour from here tonight, fading` : `up to ~${Math.max(1, ratePeak)} an hour from here on the peak night`;
    const lit = peakDay || on ? moon.lit : moonPeak.lit;
    let text;
    if (!night) text = `${s.name} ${when}, but there's no dark sky here to see them.`;
    else if (bestAlt < 10) text = `${s.name} ${when}: the radiant stays below the horizon from here, so you'll see few or none.`;
    else text = `${s.name} ${when}: ${howMany}, best around ${time(best)} with the radiant ${Math.round(bestAlt)}° up in the ${dir}. Look anywhere: they streak across the whole sky.${lit > 0.6 ? ' The bright Moon washes out the faint ones.' : lit < 0.25 ? ' A dark Moon helps.' : ''}`;
    out.push({ name: s.name, peakMs, days, nights, active: on, zhr: s.zhr, rate, ratePeak, bestMs: best, radiantAlt: bestAlt, dir, moonLit: lit, kms: s.kms, parent: s.parent, ra: s.ra, dec: s.dec, text });
  }
  return out.sort((a, b) => a.peakMs - b.peakMs);
}

/** Showers active at ms (for marking radiants in look-up mode). */
export const activeShowers = ms => SHOWERS.filter(s => active(s, ms));
