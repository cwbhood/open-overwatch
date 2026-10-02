// The shared TLE source: parsing, epochs, source order, caching and failure handling (with fake network/storage).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTle, tleEpochJd, createTleSource, celestrakUrl, mirrorUrl, CACHE_MS } from '../src/core/tle.js';

const TXT = readFileSync(new URL('fixtures/stations.tle', import.meta.url), 'utf8').replace(/\n/g, '\r\n'); // CelesTrak sends CRLF

test('parseTle: named and bare entries, CRLF, trailing spaces', () => {
  const t = parseTle(TXT);
  assert.deepEqual(t.map(s => [s.id, s.name]), [['25544', 'ISS (ZARYA)'], ['48274', 'CSS (TIANHE)'], ['66052', '66052']]);
  assert.ok(t[0].l1.startsWith('1 25544') && t[0].l2.startsWith('2 25544'));
  assert.deepEqual(parseTle('garbage\nmore garbage\n'), []);
});

test('tleEpochJd: day-of-year epochs', () => {
  assert.ok(Math.abs(tleEpochJd(parseTle(TXT)[0].l1) - (Date.UTC(2026, 0, 1) / 86400000 + 2440587.5 + 273.49758378)) < 1e-9);
  assert.equal(new Date((tleEpochJd('1 00005U 58002B   00001.00000000') - 2440587.5) * 86400000).toISOString(), '2000-01-01T00:00:00.000Z');
});

function rig({ onSite = false, responses = {}, cached = null, t = 1e12 } = {}) {
  const calls = [], store = new Map(cached ? [['tle.stations', cached]] : []);
  const fetchText = async url => { calls.push(url); const r = responses[url]; if (r instanceof Error) throw r; if (r == null) throw new Error('HTTP 404'); return r; };
  const src = createTleSource({ fetchText, onSite, now: () => t, cache: { get: k => store.get(k) || null, set: (k, v) => (store.set(k, v), true) } });
  return { src, calls, store };
}

test('source order: CelesTrak first off-site, the site copy first on the website', async () => {
  const a = rig({ responses: { [celestrakUrl('stations')]: TXT } });
  assert.equal((await a.src.load('stations')).source, 'celestrak');
  assert.deepEqual(a.calls, [celestrakUrl('stations')]);
  const b = rig({ onSite: true, responses: { [mirrorUrl('stations')]: TXT } });
  assert.equal((await b.src.load('stations')).source, 'mirror');
  assert.deepEqual(b.calls, [mirrorUrl('stations')]);
});

test('a network failure marks CelesTrak down: later groups skip straight to the copy', async () => {
  const r = rig({ responses: { [celestrakUrl('stations')]: new TypeError('Failed to fetch'), [mirrorUrl('stations')]: TXT, [mirrorUrl('visual')]: TXT } });
  assert.equal((await r.src.load('stations')).source, 'mirror');
  assert.ok(r.src.celestrakDown);
  await r.src.load('visual');
  assert.deepEqual(r.calls, [celestrakUrl('stations'), mirrorUrl('stations'), mirrorUrl('visual')]);
});

test('cache: fresh copies skip the network; stale ones are the last resort', async () => {
  const fresh = rig({ cached: { t: 1e12 - 1000, txt: TXT } });
  assert.equal((await fresh.src.load('stations')).source, 'cache');
  assert.equal(fresh.calls.length, 0);
  const stale = rig({ cached: { t: 1e12 - CACHE_MS - 1, txt: TXT } });
  const res = await stale.src.load('stations');
  assert.equal(res.source, 'stale cache'); assert.equal(stale.calls.length, 2);
});

test('failures: CelesTrak 403 gets a plain explanation; HTML instead of TLEs is rejected', async () => {
  await assert.rejects(rig({ responses: { [celestrakUrl('stations')]: new Error('HTTP 403') } }).src.load('stations'), /once|one download per group/);
  const html = rig({ responses: { [celestrakUrl('stations')]: '<html>blocked</html>' } });
  await assert.rejects(html.src.load('stations'), /unexpected response/);
});
