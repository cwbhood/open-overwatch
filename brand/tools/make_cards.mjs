// make_cards.mjs — caption overlays, intro/end cards and share images for the promo, rendered with headless Edge.
// Text is real HTML in the brand fonts (Big Shoulders Display, Barlow, IBM Plex Mono from Google Fonts).
//
//   node make_cards.mjs captions        transparent 1080x1920 caption overlays, one per map shot
//   node make_cards.mjs intro end       intro lockup + end card (need brand/emblem and the globe renders)
//   node make_cards.mjs social          share images into brand/social (need brand/hero + brand/emblem)
//
// Numbers in the captions come from <WORK>/footage/manifest.json, i.e. what the map really showed when it was recorded.
import { launch, WORK } from './cdp.mjs';
import { snapCard } from './capture.mjs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const BRAND = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const CARDS = path.join(WORK, 'cards');
const url = p => pathToFileURL(p).href;

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@700;900&family=Barlow:wght@500;600&family=IBM+Plex+Mono:wght@500&display=block">`;

const BASE_CSS = `
:root{--bg:#04060a;--ink:#e6edf3;--dim:#b3c1cf;--accent:#7dffa6;--civ:#5fd3ff;--mil:#ffb44d;--sat:#d9ccff;--qk:#ff7b4f}
html,body{margin:0;background:transparent;overflow:hidden}
*{box-sizing:border-box}
.kick{display:inline-flex;align-items:center;gap:14px;font:500 27px/1 "IBM Plex Mono",monospace;letter-spacing:.14em;text-transform:uppercase;
  color:var(--accent);padding:12px 20px 12px 16px;border:2px solid rgba(125,255,166,.42);border-radius:4px;background:rgba(4,6,10,.62)}
.kick i{width:14px;height:14px;border-radius:50%;background:var(--accent);box-shadow:0 0 14px var(--accent)}
.num{font:900 230px/.84 "Big Shoulders Display",sans-serif;letter-spacing:.01em;margin-top:26px}
.lbl{font:900 112px/.9 "Big Shoulders Display",sans-serif;letter-spacing:.03em;text-transform:uppercase;color:var(--ink);white-space:nowrap}
.sub{font:600 44px/1.2 Barlow,sans-serif;color:var(--dim);margin-top:20px;letter-spacing:.01em}
.shadow{text-shadow:0 4px 26px rgba(0,0,0,.7),0 0 2px rgba(0,0,0,.6)}
`;

// shrink any [data-fit] element until it fits its max width
const FIT_JS = `<script>document.fonts.ready.then(()=>{for(const el of document.querySelectorAll('[data-fit]')){const max=+el.dataset.fit;let fs=parseFloat(getComputedStyle(el).fontSize);while(el.scrollWidth>max&&fs>20){fs-=2;el.style.fontSize=fs+'px'}}})</script>`;

const fmt = n => Number(n).toLocaleString('en-US');

function captionHtml({ kicker, num, numColor, label, sub, top = 268, big = 138, scrim = 1 }) {
  return `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>${BASE_CSS}
body{width:1080px;height:1920px;position:relative}
.scrim{position:absolute;inset:0;opacity:${scrim};background:linear-gradient(180deg,rgba(4,6,10,.82) 0px,rgba(4,6,10,.66) 380px,rgba(4,6,10,.28) 700px,rgba(4,6,10,0) 900px)}
.cap{position:absolute;left:72px;top:${top}px;width:860px}
</style></head><body><div class="scrim"></div><div class="cap shadow">
<div class="kick"><i></i>${kicker}</div>
${num ? `<div class="num" style="color:${numColor}" data-fit="860">${num}</div>` : ''}
<div class="lbl" style="${num ? '' : `margin-top:30px;font-size:${big}px`}" data-fit="860">${label}</div>
<div class="sub" data-fit="860">${sub}</div>
</div>${FIT_JS}</body></html>`;
}

async function manifest() {
  const m = JSON.parse(await readFile(path.join(WORK, 'footage', 'manifest.json'), 'utf8'));
  return Object.fromEntries(m.shots.map(s => [s.id, s]));
}
const utc = s => (s.captured_utc || '').slice(11, 16) + ' UTC';

async function captions(browser) {
  const m = await manifest();
  const c = id => m[id]?.counts || {};
  const list = [
    { id: 'air_world', kicker: `Live · ${utc(m.air_world)} · ADS-B + OpenSky`, num: fmt(c('air_world').aircraft_tracked ?? 11737), numColor: 'var(--civ)', label: 'aircraft tracked', sub: 'Every transponder the open networks can hear.' },
    { id: 'air_dense', kicker: `Live · ${utc(m.air_dense)} · London airspace`, label: 'Flight by flight', sub: 'Callsign, altitude and heading for each one.' },
    { id: 'mil', kicker: `Live · ${utc(m.mil)} · Military air picture`, num: fmt(c('mil').military_airborne_worldwide ?? 236), numColor: 'var(--mil)', label: 'military flights', sub: 'Flagged in real time from open ADS-B data.' },
    { id: 'space', kicker: `Live · ${utc(m.space)} · CelesTrak`, num: fmt(c('space').satellites_propagated ?? 205), numColor: 'var(--sat)', label: 'satellites tracked', sub: 'ISS included. Orbits computed in your browser.' },
    { id: 'hazards', kicker: `Live · ${utc(m.hazards)} · USGS · NOAA · GDACS`, label: `<span style="color:var(--qk)">${c('hazards').quakes_24h_m25 ?? 44}</span> quakes<br><span style="color:#7fd0ff">${(c('hazards').storms || []).length || 10}</span> storms`, big: 128, sub: 'Earthquakes, cyclones and disasters as they happen.' },
    { id: 'ui', kicker: 'Open Overwatch', label: 'One page. Free.<br>No accounts.', sub: 'Built entirely on open data feeds.', big: 104, scrim: .55 },
  ];
  const out = [];
  for (const cap of list) {
    const html = path.join(CARDS, `cap_${cap.id}.html`), png = path.join(CARDS, `cap_${cap.id}.png`);
    await writeFile(html, captionHtml(cap));
    const r = await snapCard(html, png, 1080, 1920, { browser, settleMs: 400 });
    out.push({ id: cap.id, png, transparentPct: r.transparentPct, fonts: r.fonts.map(f => f.family + ' ' + f.weight).join(', ') });
  }
  return out;
}

// Intro lockup over the tall globe: wordmark + tagline only (the animated emblem is its own layer in the edit).
function introHtml({ top = 520 }) {
  return `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>${BASE_CSS}
body{width:1080px;height:1920px;position:relative}
.wrap{position:absolute;left:0;right:0;top:${top}px;text-align:center}
.wm{display:inline-block;font:900 110px/.9 "Big Shoulders Display",sans-serif;letter-spacing:.05em;text-transform:uppercase;color:var(--ink);white-space:nowrap;text-shadow:0 0 40px rgba(125,255,166,.18),0 4px 24px rgba(0,0,0,.7)}
.rule{width:54px;height:3px;background:var(--accent);margin:24px auto 22px}
.tag{font:500 29px/1.3 "IBM Plex Mono",monospace;letter-spacing:.16em;text-transform:uppercase;color:#a9b8c7;text-shadow:0 2px 16px rgba(0,0,0,.8)}
</style></head><body><div class="wrap"><div class="wm" data-fit="900">Open Overwatch</div>
<div class="tag" style="margin-top:18px">Everything moving on Earth · live</div></div>${FIT_JS}</body></html>`;
}

// End card text over the dimmed globe; the emblem is drawn here as a still.
function endHtml({ top = 560 }) {
  const emblem = url(path.join(BRAND, 'emblem', 'emblem-1024.png'));
  return `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>${BASE_CSS}
body{width:1080px;height:1920px;position:relative}
.wrap{position:absolute;left:0;right:0;top:${top}px;text-align:center}
.em{width:330px;height:330px;display:block;margin:0 auto 26px}
.wm{font:900 132px/.86 "Big Shoulders Display",sans-serif;letter-spacing:.05em;text-transform:uppercase;color:var(--ink);text-shadow:0 0 40px rgba(125,255,166,.18),0 4px 24px rgba(0,0,0,.7)}
.rule{width:54px;height:3px;background:var(--accent);margin:30px auto 24px}
.tag{font:500 30px/1.3 "IBM Plex Mono",monospace;letter-spacing:.16em;text-transform:uppercase;color:#a9b8c7}
.chips{display:flex;justify-content:center;gap:14px;margin-top:40px}
.chips span{font:500 25px/1 "IBM Plex Mono",monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);border:2px solid rgba(125,255,166,.4);border-radius:4px;padding:12px 16px;background:rgba(4,6,10,.6)}
</style></head><body><div class="wrap"><img class="em" src="${emblem}"><div class="wm">Open<br>Overwatch</div><div class="rule"></div>
<div class="tag">Live picture from open feeds</div><div class="chips"><span>Free</span><span>Open data</span><span>No accounts</span></div></div></body></html>`;
}

// Share images: hero render + emblem + wordmark, opaque.
function socialHtml({ w, h, hero, layout }) {
  const heroUrl = url(path.join(BRAND, 'hero', hero)), emblem = url(path.join(BRAND, 'emblem', 'emblem-1024.png'));
  const L = {
    og: { em: 150, wm: 104, tag: 24, block: 'left:84px;top:150px;text-align:left', heroPos: 'center 62%' },
    square: { em: 150, wm: 100, tag: 24, block: 'left:0;right:0;top:64px;text-align:center', heroPos: 'center 24%', oneLine: true },
    tall: { em: 300, wm: 150, tag: 30, block: 'left:0;right:0;top:280px;text-align:center', heroPos: 'center' },
  }[layout];
  return `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>${BASE_CSS}
body{width:${w}px;height:${h}px;position:relative;background:#04060a}
.hero{position:absolute;inset:0;background:url("${heroUrl}") ${L.heroPos}/cover no-repeat}
.shade{position:absolute;inset:0;background:${layout === 'og' ? 'linear-gradient(90deg,rgba(4,6,10,.88) 0%,rgba(4,6,10,.55) 45%,rgba(4,6,10,0) 75%)' : 'linear-gradient(180deg,rgba(4,6,10,.75) 0%,rgba(4,6,10,.2) 50%,rgba(4,6,10,0) 70%)'}}
.block{position:absolute;${L.block}}
.em{width:${L.em}px;height:${L.em}px;display:${layout === 'og' ? 'inline-block' : 'block'};margin:${layout === 'og' ? '0 0 18px -10px' : '0 auto 22px'}}
.wm{font:900 ${L.wm}px/.86 "Big Shoulders Display",sans-serif;letter-spacing:.05em;text-transform:uppercase;color:var(--ink);text-shadow:0 0 40px rgba(125,255,166,.18)}
.rule{width:48px;height:3px;background:var(--accent);margin:${layout === 'og' ? '24px 0 20px' : '26px auto 20px'}}
.tag{font:500 ${L.tag}px/1.3 "IBM Plex Mono",monospace;letter-spacing:.16em;text-transform:uppercase;color:#a9b8c7}
</style></head><body><div class="hero"></div><div class="shade"></div><div class="block">
<img class="em" src="${emblem}"><div class="wm">${L.oneLine ? 'Open Overwatch' : 'Open<br>Overwatch'}</div><div class="rule"></div><div class="tag">Live picture from open feeds</div></div></body></html>`;
}


// TikTok cover: hook with live numbers over the tall globe. Text stays inside the 3:4 profile-grid crop (y 240-1680).
function coverHtml() {
  const hero = url(path.join(BRAND, 'hero', 'hero-tall.jpg')), emblem = url(path.join(BRAND, 'emblem', 'emblem-1024.png'));
  return `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>${BASE_CSS}
body{width:1080px;height:1920px;position:relative;background:#04060a}
.hero{position:absolute;inset:0;background:url("${hero}") center 70%/cover no-repeat}
.shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(4,6,10,.9) 0%,rgba(4,6,10,.75) 30%,rgba(4,6,10,.15) 52%,rgba(4,6,10,0) 65%,rgba(4,6,10,.55) 100%)}
.top{position:absolute;left:72px;right:72px;top:270px}
.hook{display:block;width:max-content;font:900 150px/.88 "Big Shoulders Display",sans-serif;letter-spacing:.01em;text-transform:uppercase;color:var(--ink);margin-top:30px;white-space:nowrap}
.hook b{font-weight:900}
.brand{position:absolute;left:0;right:0;top:1300px;padding:30px 0;display:flex;align-items:center;justify-content:center;gap:22px;background:radial-gradient(ellipse 52% 50% at 50% 50%,rgba(4,6,10,.82),rgba(4,6,10,0))}
.brand img{width:130px;height:130px}
.brand .wm{font:900 78px/.9 "Big Shoulders Display",sans-serif;letter-spacing:.05em;text-transform:uppercase;color:var(--ink);text-shadow:0 0 30px rgba(125,255,166,.2),0 4px 20px rgba(0,0,0,.8)}
.brand .tag{font:500 24px/1.2 "IBM Plex Mono",monospace;letter-spacing:.16em;text-transform:uppercase;color:#a9b8c7;margin-top:10px}
</style></head><body><div class="hero"></div><div class="shade"></div>
<div class="top shadow"><div class="kick"><i></i>Live · 100% open data</div>
<div class="hook" data-fit="936"><b style="color:var(--civ)">11,737</b> planes</div>
<div class="hook" data-fit="936"><b style="color:var(--sat)">205</b> satellites</div>
<div class="hook" data-fit="936" style="color:var(--accent)">one free map</div></div>
<div class="brand"><img src="${emblem}"><div><div class="wm">Open Overwatch</div><div class="tag">Live picture from open feeds</div></div></div>
${FIT_JS}</body></html>`;
}

async function snapOpaque(browser, html, png, w, h) {
  // snapCard keeps transparency; these pages paint their own opaque background
  return snapCard(html, png, w, h, { browser, settleMs: 600 });
}

const modes = process.argv.slice(2);
const cfg = Object.fromEntries(modes.filter(a => a.includes('=')).map(a => a.replace(/^--/, '').split('=')));
await mkdir(CARDS, { recursive: true });
const browser = await launch({ windowSize: [1080, 1920] });
const result = {};
try {
  if (modes.includes('captions')) result.captions = await captions(browser);
  if (modes.includes('intro')) {
    const html = path.join(CARDS, 'intro_lockup.html'), png = path.join(CARDS, 'intro_lockup.png');
    await writeFile(html, introHtml({ top: +(cfg.introTop || 600) }));
    result.intro = await snapCard(html, png, 1080, 1920, { browser, settleMs: 400 });
  }
  if (modes.includes('end')) {
    const html = path.join(CARDS, 'end_card.html'), png = path.join(CARDS, 'end_card.png');
    await writeFile(html, endHtml({ top: +(cfg.endTop || 560) }));
    result.end = await snapCard(html, png, 1080, 1920, { browser, settleMs: 600 });
  }
  if (modes.includes('cover')) {
    const html = path.join(CARDS, 'cover.html');
    await writeFile(html, coverHtml());
    result.cover = await snapOpaque(browser, html, path.join(BRAND, 'social', 'tiktok-cover-1080x1920.png'), 1080, 1920);
  }
  if (modes.includes('social')) {
    const out = path.join(BRAND, 'social'); await mkdir(out, { recursive: true });
    for (const [name, w, h, hero, layout] of [['og-1200x630.png', 1200, 630, 'hero-wide.jpg', 'og'], ['square-1080.png', 1080, 1080, 'hero-tall.jpg', 'square']]) {
      const html = path.join(CARDS, `social_${layout}.html`);
      await writeFile(html, socialHtml({ w, h, hero, layout }));
      result[name] = await snapOpaque(browser, html, path.join(out, name), w, h);
    }
  }
} finally { await browser.close(); }
console.log(JSON.stringify(result, (k, v) => k === 'fonts' && Array.isArray(v) ? v.map(f => f.family + ' ' + f.weight + ' ' + f.status).join('; ') : v, 1));
