// globe_shot.mjs — render globe.html in headless Edge (GPU) and save screenshots, for look-development.
//   node globe_shot.mjs <out_prefix> <width>x<height> "<js run after load>" [settleSeconds] ["<js2>" settle2 ...]
// Each <js> runs in the page (async ok), then the page renders for <settle> seconds, then a PNG is written as
// <out_prefix>_<n>.png. The helper (serve.js) must be running on :8787.
import { launch, sleep } from './cdp.mjs';
import { writeFile } from 'node:fs/promises';

const [out, size, ...steps] = process.argv.slice(2);
const [W, H] = size.split('x').map(Number);
const b = await launch({ windowSize: [W, H], args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-unsafe-swiftshader'] });
try {
  const p = await b.newPage();
  await p.send('Page.enable'); await p.send('Runtime.enable');
  // every run is a fresh profile with no cache, so the live feeds would be downloaded again each time: CelesTrak
  // firewalled this network after a day of look-dev renders. Satellites come from the website's copy instead.
  await p.send('Network.enable');
  await p.send('Network.setBlockedURLs', { urls: ['*celestrak.org*', '*opensky-network.org*', '*adsb.lol*', '*adsb.fi*',
    '*airplanes.live*', '*earthquake.usgs.gov*', '*wheretheiss.at*'] });
  await p.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  const loaded = p.waitFor('Page.loadEventFired', { timeoutMs: 60000 });
  await p.send('Page.navigate', { url: 'http://localhost:8787/globe.html' });
  await loaded;
  await sleep(6000);
  const gpu = await p.eval(`(() => { const gl = OO3D.viewer.scene.context._gl; const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); })()`);
  console.log('renderer:', gpu);
  for (let i = 0; i < steps.length; i += 2) {
    const js = steps[i], settle = +(steps[i + 1] || 6);
    const r = await p.eval(`(async () => { ${js} })()`, { timeoutMs: 120000 });
    if (r !== undefined) console.log('step', i / 2, JSON.stringify(r));
    await sleep(settle * 1000);
    const shot = await p.send('Page.captureScreenshot', { format: 'png' });
    const file = `${out}_${i / 2}.png`;
    await writeFile(file, Buffer.from(shot.data, 'base64'));
    console.log('wrote', file);
  }
} finally { await b.close(); }
