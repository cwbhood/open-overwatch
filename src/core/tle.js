// Satellite element sets (TLEs) for every view: where to get them, how long to keep them, how to read them.
//
// Sources: CelesTrak (gp.php, one download per group per 2 h) and the website's own copy of each group, refreshed every
// 6 h by the site build (.github/build_site.py). On the website the copy is read first, so visitors never hit CelesTrak
// (it firewalls networks that download too often); elsewhere CelesTrak is first and the copy is the fallback.

import { SITE } from './assets.js';

export const TLE_MIRROR = SITE + 'data/tle/';
export const CACHE_MS = 2 * 3600e3;
export const celestrakUrl = group => `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=TLE`;
export const mirrorUrl = group => TLE_MIRROR + encodeURIComponent(group) + '.txt';
export const looksLikeTle = txt => /^1 \d/m.test(txt);

/** Parse 3-line (name + 2 lines) or bare 2-line TLE text. Returns [{ id, name, l1, l2 }] in file order. */
export function parseTle(txt) {
  const lines = String(txt).split(/\r?\n/).map(s => s.trimEnd()).filter(Boolean), out = [];
  for (let i = 0; i < lines.length; i++) {
    const named = lines[i][0] !== '1' || lines[i + 1]?.[0] !== '2';
    const name = named ? lines[i].trim() : null, l1 = lines[named ? i + 1 : i], l2 = lines[named ? i + 2 : i + 1];
    if (!l1 || !l2 || !l1.startsWith('1 ') || !l2.startsWith('2 ')) continue;
    const id = l1.slice(2, 7).trim();
    out.push({ id, name: name || id, l1, l2 });
    i += named ? 2 : 1;
  }
  return out;
}

/** Epoch of a TLE (line 1, columns 19-32: two-digit year + fractional day of year) as a Julian Date. */
export function tleEpochJd(l1) {
  const yy = +l1.slice(18, 20), day = +l1.slice(20, 32), year = yy < 57 ? 2000 + yy : 1900 + yy;
  return Date.UTC(year, 0, 1) / 86400000 + 2440587.5 + day - 1;
}

/**
 * A TLE source with a cache. Dependencies are passed in so each page keeps its own storage and network helper:
 *   fetchText(url, { timeout }) -> Promise<string>   (throws Error('HTTP 403') etc. on failure)
 *   cache: { get(key) -> {t, txt} | null, set(key, value) -> boolean }   (sync or async)
 *   onSite: true when running on the published website
 * load(group) resolves to { txt, source: 'cache' | 'celestrak' | 'mirror' | 'stale cache', ageMs } or throws. An error with
 * `calm: true` means every source answered 404: CelesTrak lists the group but has no TLE-format copy right now (new
 * objects whose catalogue numbers no longer fit a TLE), which is not an outage.
 */
export function createTleSource({ fetchText, cache, onSite = false, now = () => Date.now() }) {
  let celestrakDown = false;   // after one network failure, stop waiting on CelesTrak for the other groups
  const fromCelestrak = async group => {
    if (celestrakDown) throw new Error('CelesTrak unreachable');
    try { return await fetchText(celestrakUrl(group), { timeout: 25000 }); }
    catch (e) { if (!/^HTTP/.test(e.message)) celestrakDown = true; throw e; }
  };
  const fromMirror = group => fetchText(mirrorUrl(group), { timeout: 30000 });
  const order = onSite ? [['mirror', fromMirror], ['celestrak', fromCelestrak]] : [['celestrak', fromCelestrak], ['mirror', fromMirror]];

  async function load(group) {
    const key = 'tle.' + group, cached = await cache.get(key);
    if (cached && now() - cached.t < CACHE_MS) return { txt: cached.txt, source: 'cache', ageMs: now() - cached.t };
    let firstError = null, notFound = 0;
    for (const [source, get] of order) {
      try {
        const txt = await get(group);
        if (!looksLikeTle(txt)) throw new Error('unexpected response');
        await cache.set(key, { t: now(), txt });
        return { txt, source, ageMs: 0 };
      } catch (e) { firstError = firstError || e; if (/^HTTP 404/.test(e.message)) notFound++; }
    }
    if (cached) return { txt: cached.txt, source: 'stale cache', ageMs: now() - cached.t }; // orbits stay usable for days
    if (notFound === order.length) throw Object.assign(new Error(`${group}: no TLE-format data on CelesTrak right now; it is retried with the next refresh`), { calm: true });
    throw firstError.message.includes('403')
      ? new Error(`${group}: CelesTrak allows one download per group every 2 h; it will appear after their next update`)
      : new Error(`${group}: ${firstError.message}`);
  }
  return { load, get celestrakDown() { return celestrakDown; } };
}
