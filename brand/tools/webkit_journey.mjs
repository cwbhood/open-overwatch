// webkit_journey.mjs — the phone journey in Safari's engine (Playwright's WebKit build) with an iPhone profile:
// screen size, pixel ratio, touch, iOS user agent and a fixed public location. It is not iOS (no Metal, no motion
// sensors, no iOS memory limits), but it catches what breaks in WebKit: missing APIs, CSS, WebGL differences.
//   node webkit_journey.mjs [base=http://localhost:8787/]      screenshots + report in brand/perf/webkit/
// Playwright lives outside the repo (the site has no dependencies): PLAYWRIGHT_DIR, default ~/open-overwatch-work/pw.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(path.join(process.env.PLAYWRIGHT_DIR || path.join(os.homedir(), 'open-overwatch-work', 'pw'), 'package.json'));
const { webkit, devices } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8787/';
const OUT = new URL('../perf/webkit/', import.meta.url);
await mkdir(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

try { await fetch(BASE + 'index.html'); } catch (e) { console.error(`Nothing at ${BASE}: start serve.js (node serve.js) first.`); process.exit(1); }
const browser = await webkit.launch();
const ctx = await browser.newContext({ ...devices['iPhone 15'], geolocation: { latitude: 51.5007, longitude: -0.1246 }, permissions: ['geolocation'] });
for (const host of ['celestrak.org', 'opensky-network.org', 'adsb.lol', 'adsb.fi', 'airplanes.live', 'earthquake.usgs.gov', 'wheretheiss.at'])
  await ctx.route(new RegExp(`https?://([^/]*\\.)?${host.replace('.', '\\.')}/`), r => r.abort());
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('page error: ' + String(e.message).split('\n')[0].slice(0, 200)));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::|blocked/i.test(m.text())) errors.push('console: ' + m.text().slice(0, 200)); });
const report = [];
let n = 0;
async function step(name, fn) {
  const e0 = errors.length, t0 = Date.now(); let note = '';
  try { note = (await fn()) || ''; } catch (e) { note = 'FAILED: ' + e.message.split('\n')[0]; }
  const file = `${String(++n).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
  await page.screenshot({ path: fileURLToPath(new URL(file, OUT)) }).catch(e => console.log('     screenshot failed: ' + e.message));
  const r = { step: name, s: +((Date.now() - t0) / 1000).toFixed(1), note, errors: errors.slice(e0), file }; report.push(r);
  console.log(`${String(n).padStart(2)} ${name.padEnd(30)} ${String(r.s).padStart(5)} s  ${note}`);
  for (const e of r.errors.slice(0, 4)) console.log('     ' + e);
}
const tapText = async (re) => { const el = page.locator('button:visible, a:visible').filter({ hasText: re }).first(); await el.tap({ timeout: 8000 }); };

await step('landing', async () => { await page.goto(BASE + 'index.html'); return await page.title(); });
await step('globe: open', async () => {
  await page.goto(BASE + 'globe.html');
  await page.waitForFunction(() => !document.querySelector('#boot') || document.querySelector('#boot').classList.contains('out'), null, { timeout: 90000 });
  await sleep(4000);
  return await page.evaluate(() => { const gl = OO3D.viewer.scene.context._gl, e = gl.getExtension('WEBGL_debug_renderer_info'); return `${OO3D.Sats.list.length} satellites · WebGL${gl instanceof WebGL2RenderingContext ? '2' : '1'} · ${e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)}`; });
});
await step('globe: Layers', async () => { await page.locator('[data-tab=layers]').tap(); await sleep(800); });
await step('globe: Near misses', async () => { await page.locator('[data-tab=layers]').tap(); await page.locator('[data-tab=explore]').tap(); await sleep(500); await page.locator('#msheet [data-go=conj]').tap(); await sleep(1500); });
await step('globe: Eclipses', async () => { await page.locator('#card .x').tap(); await page.locator('[data-tab=explore]').tap(); await sleep(500); await page.locator('#msheet [data-go=eclipses]').tap(); await sleep(2500); return await page.locator('#card .cj').count() + ' eclipses listed'; });
await step('globe: Weather', async () => {
  await page.locator('#card .x').tap(); await page.locator('[data-tab=explore]').tap(); await sleep(500); await page.locator('#msheet [data-go=weather]').tap();
  await page.waitForFunction(() => window.OO3D && OO3D.Weather.end, null, { timeout: 30000 }); await sleep(6000);
  const r = await page.evaluate(() => ({ t: document.querySelector('#wxTime').textContent, n: document.querySelector('#wxNote').textContent, sats: OO3D.Weather.ir.length, radar: OO3D.Weather.radar.length }));
  await page.locator('[data-set=wind]').tap(); await page.locator('[data-set=temp]').tap(); await sleep(7000);
  const w = await page.evaluate(() => { const cv = document.querySelector('#windcv'); if (!cv) return 0; const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 20) n++; return n; });
  await page.locator('#wx .x').tap(); await sleep(500); return `${r.t} · ${r.n} · radar frames ${r.radar} · wind streak pixels ${w}`;
});
await step('globe: Look up', async () => {
  await page.locator('[data-tab=lookup]').tap(); await sleep(7000);
  return await page.evaluate(() => [document.querySelector('#luWhere').textContent, document.querySelector('#luNow').textContent, document.querySelector('#luPass').textContent].join(' | '));
});
await step('globe: leave Look up', async () => { await page.locator('#luExit').tap(); await sleep(1000); });
await step('solar: open', async () => {
  await page.goto(BASE + 'solar.html');
  await page.waitForFunction(() => document.querySelector('#load')?.classList.contains('gone'), null, { timeout: 60000 }); await sleep(4000);
  return await page.evaluate(() => `${OOSS.renderer.capabilities.isWebGL2 ? 'WebGL2' : 'WebGL1'} · quality ${OOSS.quality.level}`);
});
await step('solar: Other worlds', async () => { await page.locator('.rung').filter({ hasText: /other/i }).first().tap(); await sleep(8000); return await page.evaluate(() => OOSS.exo.X.built ? 'built ' + OOSS.exo.X.built.s.host : 'not built'); });
await step('map: open + silent', async () => { await page.goto(BASE + 'open-overwatch.html'); await sleep(1500); await tapText(/silent/i); await sleep(3000); });
await step('map: Space preset', async () => { await tapText(/^\s*SPACE/i); await sleep(4000); });
await writeFile(new URL('report.json', OUT), JSON.stringify(report, null, 1));
console.log(errors.length ? `${errors.length} errors in total` : 'no errors');
await browser.close();
