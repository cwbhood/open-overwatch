#!/usr/bin/env node
// Open Overwatch helper (Node 18+ or Bun, no dependencies).
// Serves this folder at http://127.0.0.1:8787/ and relays requests to a short list of data sources
// that refuse browser (CORS) requests, adding the missing Access-Control-Allow-Origin header.
// Run:  node serve.js   (or double-click "Start Open Overwatch.bat")
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), { execFile } = require('child_process');

const PORT = +(process.env.OW_PORT || 8787);
const PAGE = 'open-overwatch.html';
const DIR = __dirname;
const ALLOWED_HOSTS = new Set([
  'api.adsb.lol', 'api.airplanes.live', 'opendata.adsb.fi', 'api.adsb.one', // aircraft
  'opensky-network.org',                                                    // aircraft snapshot
  'www.nhc.noaa.gov',                                                       // hurricane advisories
  'webcams.nyctmc.org',                                                     // NYC cameras
  'api.gdeltproject.org',                                                   // news
  'firms.modaps.eosdis.nasa.gov',                                           // fires (key)
  'api.windy.com',                                                          // webcams (key)
  'celestrak.org', 'tle.ivanstanojevic.me',                                 // orbital data fallbacks
]);
const FORWARD_HEADERS = ['x-windy-api-key', 'accept'];
const UA = 'OpenOverwatch/1.0 (local helper; personal use)';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.py': 'text/plain; charset=utf-8', '.bat': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.webp': 'image/webp', '.glb': 'model/gltf-binary', '.mp4': 'video/mp4', '.wav': 'audio/wav', '.mjs': 'text/javascript; charset=utf-8' }; // brand/ assets and the 3D globe

function reply(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Access-Control-Allow-Origin': '*', 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

async function proxy(req, res, params) {
  if (params.has('ping')) return reply(res, 200, 'ok');
  let target; try { target = new URL(params.get('url') || ''); } catch (e) { return reply(res, 400, 'bad url'); }
  if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname)) return reply(res, 403, "host not in the helper's allowlist: " + target.hostname);
  const headers = { 'User-Agent': UA };
  for (const h of FORWARD_HEADERS) if (req.headers[h]) headers[h] = req.headers[h];
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 60000);
  try {
    const r = await fetch(target, { headers, signal: ctl.signal, redirect: 'follow' });
    const buf = Buffer.from(await r.arrayBuffer());
    reply(res, r.status, buf, r.headers.get('content-type') || 'application/octet-stream');
  } catch (e) { reply(res, 502, 'upstream error: ' + (e.name === 'AbortError' ? 'timeout' : e.message)); }
  finally { clearTimeout(t); }
}

function serveFile(req, res, pathname) {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(DIR, rel || PAGE));
  if (!file.startsWith(DIR)) return reply(res, 403, 'forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return reply(res, 404, 'not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' }); return res.end(); }
  if (u.pathname === '/proxy') { const host = (() => { try { return new URL(u.searchParams.get('url')).hostname; } catch (e) { return '?'; } })(); console.log(new Date().toISOString().slice(11, 19), 'relay', host); return proxy(req, res, u.searchParams); }
  if (u.pathname === '/') { res.writeHead(302, { Location: '/' + PAGE }); return res.end(); }
  serveFile(req, res, u.pathname);
});

if (!fs.existsSync(path.join(DIR, PAGE))) { console.error('Put serve.js in the same folder as ' + PAGE); process.exit(1); }
server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is busy — is the helper already running? Open http://127.0.0.1:${PORT}/${PAGE}` : e.message); process.exit(1); });
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/${PAGE}`;
  console.log(`Open Overwatch helper on ${url}  (Ctrl+C to stop)`);
  console.log('Relaying: ' + [...ALLOWED_HOSTS].sort().join(', '));
  const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  setTimeout(() => execFile(opener[0], opener[1], () => { }), 600);
});
