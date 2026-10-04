import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeView, decodeView } from '../src/core/viewlink.js';

const view = { lon: 139.6917, lat: 35.6895, height: 4_500_000, heading: 12.5, pitch: -63.2, layers: ['stations', 'quakes', 'companies'], weather: ['ir', 'wind'], time: { jd: 2461314.12345, rate: 60 }, country: 'JP' };

test('a view survives the round trip', () => {
  const back = decodeView('#' + encodeView(view));
  assert.deepEqual(back, { ...view, lon: 139.6917, lat: 35.6895 });
});

test('optional parts are optional', () => {
  const back = decodeView('#' + encodeView({ lon: 0, lat: 0, height: 2e7, heading: 0, pitch: -90 }));
  assert.equal(back.layers, null); assert.equal(back.weather, null); assert.equal(back.time, null); assert.equal(back.country, null);
});

test('bad links are refused or cleaned, never trusted', () => {
  for (const h of ['', '#', '#abc', '#c=', '#c=1,2', '#c=a,b,c', '#c=200,0,1000', '#c=0,95,1000', '#c=0,0,-5', '#c=0,0,1e12']) assert.equal(decodeView(h), null, h);
  const v = decodeView('#c=10,20,3000&l=quakes,<script>,ok_1,' + 'x'.repeat(40) + '&k=jp&t=5,1&w=ir,wind;drop');
  assert.deepEqual(v.layers, ['quakes', 'ok_1']); assert.equal(v.country, null); assert.equal(v.time, null); assert.deepEqual(v.weather, ['ir']);
});

test('missing heading and pitch default to a straight-down view', () => {
  const v = decodeView('#c=10,20,3000'); assert.equal(v.heading, 0); assert.equal(v.pitch, -90);
});
