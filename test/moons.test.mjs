// Major moons (orbits fitted to Horizons elements over 2026) against Horizons state vectors on 2026-10-02.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { moonOffset } from '../src/core/moons.js';
import { AU_KM, DEG } from '../src/core/units.js';

const H = JSON.parse(readFileSync(new URL('fixtures/horizons_2026-10-02.json', import.meta.url)));
const M = JSON.parse(readFileSync(new URL('../data/solar/moons.json', import.meta.url))).moons;
const len = v => Math.hypot(v.x, v.y, v.z);
const angle = (a, b) => Math.acos(Math.min(1, (a.x * b.x + a.y * b.y + a.z * b.z) / (len(a) * len(b)))) / DEG;

// degrees around the planet (largest today: Miranda 0.4°, Phobos 0.25°): the fit leaves out short-period terms
const TOL = 1;
for (const [name, ref] of Object.entries(H.moons)) {
  test(`moons: ${name} within ${TOL}° of Horizons, distance within 2%`, () => {
    const m = M.find(x => x.name === name), p = moonOffset(m, H.jd_tt), r = { x: ref[0], y: ref[1], z: ref[2] };
    const q = { x: p.x * AU_KM, y: p.y * AU_KM, z: p.z * AU_KM };
    assert.ok(angle(q, r) < TOL, `${name}: ${angle(q, r).toFixed(2)}°`);
    assert.ok(Math.abs(len(q) / len(r) - 1) < 0.02, `${name}: ${len(q).toFixed(0)} vs ${len(r).toFixed(0)} km`);
  });
}
