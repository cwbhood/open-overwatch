// SOCRATES close-approach parsing (synthetic rows in the documented CSV format).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvFields, parseSocrates, upcoming } from '../src/core/socrates.js';

const CSV = [
  'NORAD_CAT_ID_1,OBJECT_NAME_1,DSE_1,NORAD_CAT_ID_2,OBJECT_NAME_2,DSE_2,TCA,TCA_RANGE,TCA_RELATIVE_SPEED,MAX_PROB,DILUTION',
  '25544,ISS (ZARYA) [+],0.512,49863,"COSMOS 1408 DEB [-]",1.204,2026-10-03 04:12:33.120,0.412,14.211,1.2E-04,0.031',
  '44713,STARLINK-1007 [+],0.201,29228,"FENGYUN 1C DEB, PIECE [-]",2.5,2026-10-04 11:00:00.000,1.750,9.870,3.0E-06,0.150',
  '44714,STARLINK-1008 [+],0.3,30001,IRIDIUM 33 DEB [-],0.9,2026-10-01 00:00:00.000,0.050,11.0,1.0E-03,0.010',
  '',
].join('\r\n');

test('socrates: CSV fields with quotes and commas', () => {
  assert.deepEqual(csvFields('a,"b, c","d ""q""",e'), ['a', 'b, c', 'd "q"', 'e']);
});

test('socrates: rows, names without status, UTC times, numbers', () => {
  const r = parseSocrates(CSV);
  assert.equal(r.length, 3);
  assert.deepEqual(r[0].a, { id: '25544', name: 'ISS (ZARYA)', status: '+', dse: 0.512 });
  assert.equal(r[0].b.name, 'COSMOS 1408 DEB'); assert.equal(r[1].b.name, 'FENGYUN 1C DEB, PIECE');
  assert.equal(r[0].tca, Date.UTC(2026, 9, 3, 4, 12, 33, 120));
  assert.equal(r[0].rangeKm, 0.412); assert.equal(r[0].speedKmS, 14.211); assert.equal(r[0].maxProb, 1.2e-4);
});

test('socrates: upcoming keeps future ones, closest first', () => {
  const now = Date.UTC(2026, 9, 2), u = upcoming(parseSocrates(CSV), now);
  assert.deepEqual(u.map(x => x.a.id), ['25544', '44713']);    // the 50 m one is already past
  assert.throws(() => parseSocrates('A,B\n1,2'), /missing column/);
});
