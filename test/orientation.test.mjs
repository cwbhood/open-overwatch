// Phone orientation to view direction (look-up mode).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceVectors, alphaFromCompass, azEl } from '../src/core/orientation.js';

const near = (v, w, msg) => v.forEach((x, i) => assert.ok(Math.abs(x - w[i]) < 1e-9, `${msg}: ${v} vs ${w}`));

test('orientation: flat, upright, turned, tilted up, landscape', () => {
  near(deviceVectors(0, 0, 0).dir, [0, 0, -1], 'flat on a table: the camera looks down');
  const n = deviceVectors(0, 90, 0); near(n.dir, [0, 1, 0], 'upright, top north: looks north'); near(n.up, [0, 0, 1], 'screen up = sky');
  near(deviceVectors(90, 90, 0).dir, [-1, 0, 0], 'alpha 90 (turned left): looks west');
  assert.ok(Math.abs(azEl(deviceVectors(alphaFromCompass(90), 90, 0).dir).az - 90) < 1e-9, 'compass 90 = east');
  const up30 = azEl(deviceVectors(0, 120, 0).dir); assert.ok(Math.abs(up30.el - 30) < 1e-9 && Math.abs(up30.az) < 1e-9, 'tilted back 30 deg: 30 deg up, north');
  near(deviceVectors(0, 90, 0, 90).up, [1, 0, 0], 'landscape (screen angle 90): screen up is the phone\'s right edge');
});

test('guide: which way to turn to find something', async () => {
  const { guide } = await import('../src/core/orientation.js');
  const a = guide(0, 20, 90, 20); assert.equal(Math.round(a.dAz), 90); assert.match(a.text, /^turn right 90°$/); assert.ok(Math.abs(a.arrow - 90) < 1);
  const b = guide(350, 10, 20, 50); assert.equal(Math.round(b.dAz), 30); assert.match(b.text, /turn right 30°, up 40°/);
  assert.match(guide(100, 30, 60, 30).text, /^turn left 40°$/);
  assert.equal(guide(200, 45, 201, 46).text, 'There it is!');
  assert.match(guide(200, -10, 201, -11).text, /below the horizon/);
});
