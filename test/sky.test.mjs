// Tonight's sky (src/core/sky.js), calendar alerts (src/core/ics.js) and flight queries (src/core/flight.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gmst, bodyRaDec, altAz, sunAlt, moonPhase, darkWindow, planetsTonight, auroraAt, describePass, starlinkTrains } from '../src/core/sky.js';
import { makeIcs } from '../src/core/ics.js';
import { parseFlightQuery, matchesFlight, normCallsign } from '../src/core/flight.js';
import { jdFromMs } from '../src/core/time.js';

const ms = iso => Date.parse(iso);

test('sky: sidereal time and the Sun', () => {
  assert.ok(Math.abs(gmst(2451545.0) - 280.46061837) < 1e-6);
  // equinox 2024-03-20 03:06 UTC: the Sun at RA ~0, Dec ~0
  const s = bodyRaDec('sun', jdFromMs(ms('2024-03-20T03:06:00Z')));
  assert.ok(Math.min(s.ra, 360 - s.ra) < 0.6 && Math.abs(s.dec) < 0.3, JSON.stringify(s));
  // midsummer noon in Greenwich: the Sun due south, 90 - 51.48 + 23.44 = ~62 deg up
  const t = ms('2024-06-20T12:02:00Z'), a = altAz(bodyRaDec('sun', jdFromMs(t)), 51.48, 0, jdFromMs(t));
  assert.ok(Math.abs(a.alt - 61.96) < 0.6 && Math.abs(a.az - 180) < 2, JSON.stringify(a));
  assert.ok(sunAlt(51.48, 0, ms('2024-06-21T00:00:00Z')) < -10);
});

test('sky: Moon phases (2024-04-08 eclipse = new, 2024-04-23 = full, 2024-04-15 = first quarter)', () => {
  assert.equal(moonPhase(ms('2024-04-08T18:00:00Z')).name, 'New Moon');
  assert.equal(moonPhase(ms('2024-04-23T23:49:00Z')).name, 'Full Moon');
  const q = moonPhase(ms('2024-04-15T19:13:00Z')); assert.equal(q.name, 'First quarter'); assert.ok(q.waxing);
});

test('sky: dark windows and planets', () => {
  const w = darkWindow(51.48, 0, ms('2024-12-01T12:00:00Z'));
  assert.ok(w && w.end - w.start > 13 * 3600e3, 'a long December night in London');
  assert.equal(darkWindow(78.2, 15.6, ms('2024-06-21T00:00:00Z')), null);   // Svalbard midsummer
  // 2025-01-20: Venus bright in the SW after dusk, Jupiter high most of the night, Mars at opposition all night
  const p = Object.fromEntries(planetsTonight(51.48, 0, ms('2025-01-20T12:00:00Z')).map(x => [x.key, x]));
  assert.ok(p.venus.up && /after dusk/.test(p.venus.text) && ['SW', 'WSW', 'SSW'].includes(p.venus.text.match(/in the (\w+)/)[1]), p.venus.text);
  assert.ok(p.jupiter.up && p.jupiter.alt > 45, p.jupiter.text);
  assert.ok(p.mars.up && p.mars.to - p.mars.from > 10 * 3600e3, p.mars.text);
});

test('sky: aurora chance from an OVATION grid', () => {
  const grid = []; for (let lon = 0; lon < 360; lon++) for (let lat = -90; lat <= 90; lat++) grid.push([lon, lat, lat >= 64 && lat <= 70 ? 40 : 0]);
  assert.equal(auroraAt(grid, 67, 20).level, 3);                        // under the oval
  const near = auroraAt(grid, 58, 20); assert.equal(near.level, 2); assert.match(near.text, /northern horizon/);
  assert.equal(auroraAt(grid, 45, 20).level, 0);
  assert.equal(auroraAt(grid, -60, 20).level, 0);                       // nothing in the south
  assert.equal(auroraAt(grid, 67, -20).overhead, 40);                    // west longitudes wrap to 340
});

test('sky: a pass as a sentence, and Starlink trains', () => {
  const s = describePass('ISS', { rise: ms('2026-10-05T19:42:00Z'), set: ms('2026-10-05T19:48:00Z'), maxEl: 64, azRise: 300, azSet: 130, visible: true });
  assert.equal(s, 'ISS at 19:42 UTC: look WNW, it climbs nearly overhead (64°) and sets in the SE · 6 min · bright, easy to see');
  const tle = (name, launch, n) => ({ name, l1: `1 99999U ${launch}A   26278.5 .00000000  00000-0  00000-0 0  9990`, l2: `2 99999  53.0000 100.0000 0001000  90.0000 270.0000 ${n.toFixed(8)}    10` });
  const list = [...Array(6)].map(() => tle('STARLINK-1', '26101', 15.9)).concat([...Array(6)].map(() => tle('STARLINK-2', '25050', 15.06)), [...Array(3)].map(() => tle('STARLINK-3', '26110', 15.8)));
  const t = starlinkTrains(list);
  assert.equal(t.length, 1); assert.equal(t[0].launch, '2026-101'); assert.equal(t[0].count, 6);
});

test('ics: a calendar event with a 10-minute reminder', () => {
  const s = makeIcs([{ uid: 'iss-1@oo', start: ms('2026-10-05T19:42:00Z'), end: ms('2026-10-05T19:48:00Z'), title: 'ISS pass, look WNW', details: 'Climbs to 64°; sets SE, bright', alarmMin: 10 }], { now: 0 });
  assert.match(s, /^BEGIN:VCALENDAR\r\n/); assert.match(s, /\r\nEND:VCALENDAR\r\n$/);
  assert.match(s, /DTSTART:20261005T194200Z\r\n/); assert.match(s, /TRIGGER:-PT10M\r\n/);
  assert.match(s, /DESCRIPTION:Climbs to 64°\\; sets SE\\, bright/);
  const long = makeIcs([{ uid: 'x', start: 0, title: 'A'.repeat(200) }]);
  assert.ok(long.split('\r\n').every(l => new TextEncoder().encode(l).length <= 75));
});

test('flight: ticket numbers, callsigns, hex and registrations', () => {
  assert.deepEqual(parseFlightQuery('BA 123').callsigns, ['BAW123', 'BA123']);
  assert.deepEqual(parseFlightQuery('baw0123').callsigns, ['BAW123']);
  assert.deepEqual(parseFlightQuery('U2 8123').callsigns, ['EZY8123', 'U28123']);
  assert.equal(parseFlightQuery('3c6444').hex, '3c6444');
  assert.equal(parseFlightQuery('G-EUPT').reg, 'G-EUPT');
  assert.equal(parseFlightQuery('N123AB').reg, 'N123AB');
  assert.equal(parseFlightQuery(''), null); assert.equal(parseFlightQuery('<script>alert(1)</script>'), null);
  assert.equal(normCallsign('BAW0123 '), 'BAW123');
  const q = parseFlightQuery('BA123');
  assert.ok(matchesFlight({ flight: 'BAW123  ' }, q)); assert.ok(!matchesFlight({ flight: 'BAW1234' }, q));
  assert.ok(matchesFlight({ hex: '3C6444' }, parseFlightQuery('3c6444')));
});

test('meteors: the Perseids from London in August, the Geminids over New Year, nothing in early June', async () => {
  const { showersFor, activeShowers } = await import('../src/core/meteors.js');
  const per = showersFor(51.48, 0, Date.parse('2026-08-09T12:00:00Z')).find(s => s.name === 'Perseids');
  assert.ok(per && per.active && Math.round(per.days) === 3, JSON.stringify(per));
  assert.ok(per.radiantAlt > 50 && per.rate > 5 && per.ratePeak > per.rate && per.ratePeak < 100, per.text);
  assert.match(per.text, /peaks in 3 days/);
  assert.ok(activeShowers(Date.parse('2027-01-02T00:00:00Z')).some(s => s.name === 'Quadrantids'));      // wraps past New Year
  assert.equal(showersFor(51.48, 0, Date.parse('2026-06-05T12:00:00Z'), { ahead: 10 }).length, 0);
  const south = showersFor(-33.9, 151.2, Date.parse('2026-12-13T08:00:00Z')).find(s => s.name === 'Ursids');   // Sydney: the Ursid radiant never rises
  assert.ok(south && /below the horizon/.test(south.text), south && south.text);
});

test('explain: a friendly sentence for any satellite', async () => {
  const { explainSat } = await import('../src/core/explain.js');
  assert.match(explainSat({ name: 'ISS (ZARYA)' }), /International Space Station/);
  assert.match(explainSat({ name: 'STARLINK-1007' }), /Starlink/);
  assert.match(explainSat({ name: 'SL-16 R/B' }), /rocket stage/);
  assert.match(explainSat({ name: 'INTELSAT 901', layer: 'geo' }, { alt: 35790 }), /geostationary/);
  assert.match(explainSat({ name: 'OBJECT A', layer: 'active' }, { alt: 520, period: 95 }), /520 km up/);
});

test('launches: Launch Library 2 records, countdowns and fuzzy dates', async () => {
  const { fromLL2, countdown, when, upcoming } = await import('../src/core/launches.js');
  const { readFileSync } = await import('node:fs');
  const raw = JSON.parse(readFileSync(new URL('./fixtures/ll2_launch.json', import.meta.url), 'utf8')).results[0];
  const l = fromLL2(raw);
  assert.equal(l.rocket, 'Falcon 9 Block 5'); assert.equal(l.provider, 'SpaceX'); assert.ok(Math.abs(l.lat - 34.632) < 1e-6 && Math.abs(l.lon + 120.611) < 1e-6);
  assert.ok(Number.isFinite(l.net)); assert.match(l.place, /Vandenberg/); assert.ok(l.webcasts.every(v => v.url.startsWith('https://')));
  assert.equal(fromLL2({ ...raw, pad: { latitude: 'x', longitude: 2 } }), null);
  assert.deepEqual(fromLL2({ ...raw, vid_urls: [{ url: 'javascript:alert(1)' }, { url: 'https://x.example/"onload=1' }] }).webcasts, []);   // only plain https links
  assert.equal(countdown(Date.UTC(2026, 0, 2, 4, 10, 22), Date.UTC(2026, 0, 1)), 'T-1 d 04:10:22');
  assert.equal(countdown(1000, 73000), 'T+00:01:12');
  assert.match(when({ net: Date.UTC(2027, 2, 1), precision: 'M' }), /March 2027/);
  assert.match(when({ net: Date.UTC(2027, 3, 1), precision: 'Q2' }), /^Q2 2027/);
  assert.deepEqual(upcoming([{ net: 5e6 }, { net: 1e6 }, { net: -9e6 }], 0).map(x => x.net), [1e6, 5e6]);
});

test('explain: oceans for points at sea', async () => {
  const { oceanAt } = await import('../src/core/explain.js');
  assert.equal(oceanAt(0, -150), 'the Pacific Ocean'); assert.equal(oceanAt(10, 170), 'the Pacific Ocean');
  assert.equal(oceanAt(30, -40), 'the Atlantic Ocean'); assert.equal(oceanAt(-20, 75), 'the Indian Ocean');
  assert.equal(oceanAt(35, 18), 'the Mediterranean'); assert.equal(oceanAt(-65, 0), 'the Southern Ocean'); assert.equal(oceanAt(25, -88), 'the Atlantic Ocean');
});
