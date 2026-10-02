// Dead reckoning and great-circle helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { destination, haversine, deadReckon, EARTH_RADIUS_M } from '../src/core/geo.js';

test('destination: quarter of the way round the equator, and due north', () => {
  const q = destination(0, 0, Math.PI / 2 * EARTH_RADIUS_M, 90);
  assert.ok(Math.abs(q.lat) < 1e-9 && Math.abs(q.lon - 90) < 1e-9);
  const n = destination(10, 20, 111195, 0);                      // ~1 degree of latitude
  assert.ok(Math.abs(n.lat - 11) < 1e-3 && Math.abs(n.lon - 20) < 1e-9);
  assert.ok(Math.abs(destination(0, 179, 222390, 90).lon + 179) < 1e-3);   // wraps across the antimeridian
});

test('haversine agrees with destination', () => {
  const p = destination(51.47, -0.45, 5.5e6, 288);              // London Heathrow, westbound
  assert.ok(Math.abs(haversine(51.47, -0.45, p.lat, p.lon) - 5.5e6) < 1);
});

test('deadReckon: moves fast movers, leaves parked and slow ones alone', () => {
  const a = { lat: 40, lon: -74, gs: 230, track: 45, ground: false };
  const p = deadReckon(a, 600);
  assert.ok(Math.abs(haversine(40, -74, p.lat, p.lon) - 138000) < 1);
  assert.deepEqual(deadReckon({ ...a, ground: true }, 600), { lat: 40, lon: -74 });
  assert.deepEqual(deadReckon({ ...a, gs: 8 }, 600), { lat: 40, lon: -74 });
  assert.deepEqual(deadReckon({ ...a, track: null }, 600), { lat: 40, lon: -74 });
});
