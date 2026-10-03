// Eclipse geometry on synthetic, exactly aligned set-ups (Sun, Moon and the sub-solar point on one line).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shadowCenter, outline, overlapFraction, seenFrom, rayEllipsoid, interp, WGS84 } from '../src/core/eclipse.js';

const SUN = { x: 1.496e8, y: 0, z: 0 };
const moonAt = km => ({ x: km, y: 0, z: 0 });

test('eclipse: Moon near perigee gives a total eclipse ~180 km wide; at mean distance an annular one', () => {
  const near = shadowCenter(SUN, moonAt(360000));
  assert.equal(near.kind, 'total'); assert.ok(Math.abs(near.center.x - WGS84.a) < 1e-6);
  assert.ok(near.umbra > 80 && near.umbra < 110, `umbra radius ${near.umbra}`);
  const mean = shadowCenter(SUN, moonAt(384400));
  assert.equal(mean.kind, 'annular'); assert.ok(mean.umbra < 0 && mean.umbra > -40, `antumbra ${mean.umbra}`);
  assert.ok(mean.penumbra > 3300 && mean.penumbra < 3700, `penumbra ${mean.penumbra}`);
});

test('eclipse: an axis that misses the Earth has no centre; outlines lie on the ellipsoid', () => {
  const off = shadowCenter(SUN, { x: 380000, y: 9000, z: 0 }); assert.equal(off.center, null); assert.ok(off.miss > 8000);
  for (const p of outline(SUN, moonAt(360000), 'umbra', 16)) assert.ok(Math.abs((p.x / WGS84.a) ** 2 + (p.y / WGS84.a) ** 2 + (p.z / WGS84.b) ** 2 - 1) < 1e-9);
  assert.equal(rayEllipsoid({ x: 1e5, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }), null, 'pointing away');
});

test('eclipse: covered fraction and what an observer sees', () => {
  assert.equal(overlapFraction(1, 1, 2.5), 0); assert.equal(overlapFraction(1, 1.1, 0), 1); assert.ok(Math.abs(overlapFraction(1, 0.9, 0) - 0.81) < 1e-12);
  assert.ok(Math.abs(overlapFraction(1, 1, 1) - 0.391) < 0.001);   // two unit circles one radius apart overlap 39.1%
  const under = seenFrom(SUN, moonAt(360000), { x: WGS84.a, y: 0, z: 0 });
  assert.equal(under.kind, 'total'); assert.equal(under.covered, 1); assert.ok(under.sunUp);
  const far = seenFrom(SUN, moonAt(360000), { x: 0, y: WGS84.a, z: 0 });   // 90 deg away: the Moon is off the Sun
  assert.equal(far.kind, 'none');
  assert.deepEqual(interp([[0, 0, 0], [60, 6, 0.6]], 0.5), { x: 30, y: 3, z: 0.3 });
});
