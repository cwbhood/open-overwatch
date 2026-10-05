import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { num, idArg, esc } from '../src/core/format.js';

test('num: text where a number should be becomes 0, numbers pass', () => {
  for (const evil of ['1);alert(1);//', 'NaN', '', null, undefined, {}, [], 'x', Infinity]) assert.equal(num(evil), 0, String(evil));
  assert.equal(num('12.5'), 12.5); assert.equal(num(-3), -3); assert.equal(num(0), 0);
  assert.equal(`flyTo(${num('1);alert(1);//')},${num(8)},9)`, 'flyTo(0,8,9)');
});

test('idArg: only word characters, dot, tilde and hyphen survive', () => {
  assert.equal(idArg("x');alert(1);//"), 'xalert1'); assert.equal(idArg('~4ca123'), '~4ca123'); assert.equal(idArg('A1-b.2_c'), 'A1-b.2_c'); assert.equal(idArg(null), '');
  assert.ok(!/['"()<>;\s&]/.test(idArg('"><img src=x onerror=alert(1)>')));
});

test('esc does the HTML part', () => {
  assert.equal(esc('<img src=x onerror="a()">'), '&lt;img src=x onerror=&quot;a()&quot;&gt;');
});

// The 2D map builds HTML from feed data, and anything an uploader can influence (a SondeHub balloon, an ADS-B hex) must not reach an
// inline handler unsanitised. Every ${...} inside an onclick="..." in src/map must be wrapped in num(...) or idArg(...).
test('every inline handler in the 2D map wraps what it interpolates', () => {
  const dir = new URL('../src/map/', import.meta.url); let seen = 0; const bad = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith('.js'))) {
    const text = readFileSync(new URL(f, dir), 'utf8');
    for (const m of text.matchAll(/on(?:click|input|change|mouse\w+|key\w+)="([^"]*)"/g)) {
      for (const e of m[1].matchAll(/\$\{([^}]*)\}/g)) { seen++; if (!/^\s*(num|idArg)\(/.test(e[1])) bad.push(`${f}: ${m[0].slice(0, 90)}`); }
    }
  }
  assert.ok(seen >= 10, 'expected to find the existing handlers');
  assert.deepEqual(bad, []);
});
