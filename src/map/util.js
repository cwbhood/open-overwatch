// Helpers, settings storage, log + toast + sounds, the network layer with the local relay, the clock.

/** Modules defined later register here, for the few references that point forward. */
export const late = {};

// boot guard: a top-level exception (or Leaflet missing from the CDN) stops INIT, so say why on the splash instead of
// leaving it on "booting"; window.OW is only set once INIT has finished
window.addEventListener('error', e => {
  const b = document.getElementById('boot'); if (window.OW || !b) return;
  const d = document.createElement('div'); d.innerHTML = '<span>startup failed</span><span class="bad"></span>';
  d.lastChild.textContent = typeof L === 'undefined' ? 'the map library (Leaflet) did not load from cdnjs. Check the internet connection, then reload.' : (e.message || 'script error'); b.appendChild(d);
});
/* ============================================================ helpers */
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
export const fmt = {
  n: (v, d = 0) => (v == null || isNaN(v)) ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }),
  ll: (lat, lon) => `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`,
  hms: d => new Date(d).toISOString().substr(11, 8),
  hm: d => new Date(d).toISOString().substr(11, 5) + 'Z',
  ago: t => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? s.toFixed(0) + 's' : s < 3600 ? (s / 60).toFixed(0) + 'm' : (s / 3600).toFixed(1) + 'h'; },
  dist: m => m < 1000 ? m.toFixed(0) + ' m' : (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km',
  ft: m => fmt.n(m / 0.3048) + ' ft',
  date: t => new Date(t).toISOString().replace('T', ' ').slice(0, 16) + 'Z',
  mins: m => m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`,
};
export function haversine(lat1, lon1, lat2, lon2) { const R = 6371000, dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1); const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(a)); }
export function destination(lat, lon, brg, dist) { const R = 6371000, b = rad(brg), d = dist / R, la = rad(lat), lo = rad(lon); const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b)); const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2)); return [deg(la2), ((deg(lo2) + 540) % 360) - 180]; }
export function bearingTo(lat1, lon1, lat2, lon2) { const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2)); const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1)); return (deg(Math.atan2(y, x)) + 360) % 360; }
export function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
export function throttle(fn, ms) { let last = 0, t; return (...a) => { const now = Date.now(); if (now - last >= ms) { last = now; fn(...a); } else { clearTimeout(t); t = setTimeout(() => { last = Date.now(); fn(...a); }, ms - (now - last)); } }; }
export function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
export const C = {};
['civ', 'mil', 'emg', 'sat', 'ship', 'bal', 'cam', 'qk', 'evt', 'news', 'infra', 'cable', 'alert', 'accent', 'ink', 'ink-dim', 'ink-faint', 'warn'].forEach(k => C[k.replace('-', '_')] = cssVar('--' + k));
export const FONT_MONO = cssVar('--font-mono');
export function hexA(hex, a) { const h = hex.replace('#', ''); const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; }
export function safeHost(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }
export function isHttp(u) { return /^https?:\/\//i.test(String(u || '')); }
export function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
export const PHONE = matchMedia('(max-width:900px)'); // the CSS phone layout (bottom sheets); keep in sync with the @media rules

/* Named regions for "near …" / "over the …" phrasing: nearest reference point wins */
export const REGIONS = [['North Atlantic', 45, -35], ['Mid-Atlantic', 25, -45], ['South Atlantic', -25, -15], ['North Pacific', 40, -160], ['Central Pacific', 10, -160], ['South Pacific', -25, -140], ['Eastern Pacific', 15, -110], ['Indian Ocean', -15, 75], ['Arabian Sea', 15, 63], ['Bay of Bengal', 13, 88], ['Southern Ocean', -62, 20], ['Arctic Ocean', 82, 0], ['Antarctica', -80, 60],
  ['the Baltic', 58, 21], ['the North Sea', 56, 3], ['the English Channel', 49.8, -1.5], ['the Black Sea', 43.5, 34], ['the Eastern Mediterranean', 34, 30], ['the Central Mediterranean', 37, 15], ['the Western Mediterranean', 39, 3], ['the Adriatic', 43, 15], ['the Aegean', 38, 25], ['the Persian Gulf', 26.5, 52], ['the Red Sea', 20, 38], ['the Gulf of Aden', 12.5, 47], ['the Caspian', 41, 51], ['the Sea of Japan', 40, 135], ['the East China Sea', 29, 125], ['the Yellow Sea', 36, 123], ['the Taiwan Strait', 24.5, 119.5], ['the South China Sea', 14, 114], ['the Philippine Sea', 18, 130], ['the Gulf of Mexico', 25, -90], ['the Caribbean', 15, -73], ['Hudson Bay', 59, -85], ['the Bering Sea', 58, -175], ['the Norwegian Sea', 68, 5], ['the Barents Sea', 74, 38],
  ['Alaska', 64, -150], ['the Pacific Northwest', 46, -122], ['California', 36.5, -119.5], ['the Rockies', 42, -110], ['the Southwest US', 34, -108], ['Texas', 31, -99], ['the US Midwest', 41.5, -90], ['the US Southeast', 33, -84], ['Florida', 28, -82], ['the US Northeast', 42, -74], ['the Great Lakes', 45, -84], ['Eastern Canada', 50, -70], ['Western Canada', 54, -120], ['the Canadian Arctic', 72, -95], ['Greenland', 72, -40], ['Mexico', 23, -102], ['Central America', 13, -86], ['Colombia', 4, -73], ['Venezuela', 8, -66], ['Brazil', -10, -52], ['the Andes', -20, -68], ['Argentina', -36, -64], ['Chile', -40, -72],
  ['Iceland', 65, -18], ['the UK', 52.8, -1.8], ['Ireland', 53, -8], ['Scandinavia', 62, 12], ['Finland', 63, 26], ['the Iberian Peninsula', 40, -4], ['France', 47, 2], ['the Low Countries', 52, 5], ['Germany', 51, 10], ['the Alps', 46.5, 10], ['Italy', 42.5, 12.5], ['Poland', 52, 20], ['the Baltic states', 57, 25], ['Belarus', 53.5, 28], ['Ukraine', 49, 32], ['the Balkans', 43, 21], ['Romania', 45.5, 25], ['Greece', 39, 22], ['Turkey', 39, 35], ['the Caucasus', 42, 44], ['the Levant', 33, 36], ['Iraq', 33, 44], ['Iran', 32, 53], ['the Arabian Peninsula', 23, 45], ['Egypt', 27, 30], ['Libya', 27, 17], ['the Maghreb', 32, 2], ['the Sahel', 15, 5], ['West Africa', 8, -5], ['Nigeria', 9, 8], ['the Horn of Africa', 8, 44], ['East Africa', -2, 37], ['Central Africa', 0, 20], ['Southern Africa', -26, 25], ['Madagascar', -19, 47],
  ['Western Russia', 56, 40], ['the Urals', 57, 60], ['Siberia', 62, 100], ['the Russian Far East', 55, 135], ['Kamchatka', 56, 160], ['Central Asia', 43, 65], ['Afghanistan', 33, 66], ['Pakistan', 30, 69], ['Northern India', 27, 78], ['Southern India', 13, 78], ['the Himalayas', 29, 86], ['Western China', 38, 85], ['Northern China', 40, 115], ['Eastern China', 30, 118], ['Southern China', 24, 110], ['Mongolia', 46, 104], ['the Korean Peninsula', 37.5, 127.5], ['Japan', 36, 138], ['Okinawa', 26.5, 128], ['Taiwan', 23.7, 121], ['the Philippines', 12, 122], ['Vietnam', 16, 107], ['Thailand', 15, 101], ['Indonesia', -3, 115], ['Malaysia', 4, 108], ['Papua New Guinea', -6, 146], ['Northern Australia', -15, 133], ['Western Australia', -27, 120], ['Eastern Australia', -30, 148], ['New Zealand', -41, 173], ['Hawaii', 21, -157], ['Guam', 13.5, 144.8], ['Micronesia', 5, 155], ['Polynesia', -15, -150]];
export function regionOf(lat, lon) { let best = null, bd = Infinity; for (const [name, la, lo] of REGIONS) { const d = haversine(lat, lon, la, lo); if (d < bd) { bd = d; best = name; } } return best; }

/* ============================================================ store */
export const Store = {
  get(k, d) { try { const v = localStorage.getItem('ow.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('ow.' + k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  del(k) { try { localStorage.removeItem('ow.' + k); } catch (e) { } },
};

/* ============================================================ log + toast + sound */
export let toastT;
export function toast(msg, kind = '') { const el = $('#toast'); el.textContent = msg; el.className = 'show ' + kind; clearTimeout(toastT); toastT = setTimeout(() => el.className = '', kind === 'alert' ? 7000 : 3200); }
export const Sound = {
  on: Store.get('sound', false), ctx: null,
  toggle(v) { this.on = v == null ? !this.on : v; Store.set('sound', this.on); const b = $('#btnSound'); if (b) { $('span', b).textContent = this.on ? 'alerts on' : 'alerts off'; b.classList.toggle('on', this.on); } if (this.on) this.ping('ok'); },
  ping(kind = 'alert') {
    if (!this.on) return;
    try {
      this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)(); const c = this.ctx; if (c.state === 'suspended') c.resume();
      const notes = kind === 'alert' ? [[880, 0, .12], [1174, .14, .12], [880, .28, .12], [1174, .42, .2]] : [[660, 0, .08], [990, .1, .12]];
      for (const [f, t, d] of notes) { const o = c.createOscillator(), g = c.createGain(); o.type = 'sine'; o.frequency.value = f; g.gain.setValueAtTime(0.0001, c.currentTime + t); g.gain.exponentialRampToValueAtTime(.18, c.currentTime + t + .01); g.gain.exponentialRampToValueAtTime(.0001, c.currentTime + t + d); o.connect(g).connect(c.destination); o.start(c.currentTime + t); o.stop(c.currentTime + t + d + .05); }
    } catch (e) { }
  },
};
export const Log = {
  el: null, unread: 0, max: 400,
  add(kind, msg, opts = {}) {
    const t = Date.now();
    if (kind === 'alert') { toast(msg, 'alert'); Sound.ping('alert'); }
    if (!this.el) return;
    const d = document.createElement('div'); d.className = 'row ' + kind;
    d.innerHTML = `<span class="t">${fmt.hms(t)}</span><span class="m">${opts.html ? msg : esc(msg)}</span>`;
    if (opts.onclick) { const m = d.querySelector('.m'); m.style.cursor = 'pointer'; m.addEventListener('click', opts.onclick); }
    this.el.prepend(d);
    while (this.el.children.length > this.max) this.el.lastChild.remove();
    if (!$('#tab-log').classList.contains('on')) { this.unread++; $('#logCount').textContent = this.unread; }
  },
  info(m, o) { this.add('ok', m, o); }, warn(m, o) { this.add('warn', m, o); }, error(m, o) { this.add('error', m, o); }, alert(m, o) { this.add('alert', m, o); },
};

/* ============================================================ network + relay
   Some sources refuse browser requests (no CORS headers). When the page is served by the bundled
   helper (serve.py / serve.js) those go through its /proxy route; otherwise they are reported as blocked. */
export const NEEDS_RELAY = ['api.adsb.lol', 'api.airplanes.live', 'opendata.adsb.fi', 'api.adsb.one', 'www.nhc.noaa.gov', 'webcams.nyctmc.org', 'opensky-network.org', 'firms.modaps.eosdis.nasa.gov', 'api.windy.com', 'www.submarinecablemap.com'];
export const Relay = {
  local: /^https?:$/.test(location.protocol) && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname),
  custom: Store.get('proxy', ''), customOk: null, available: false, checked: false, // customOk: null = not tested yet
  base() { return (this.custom && this.customOk !== false) ? this.custom : (this.local ? location.origin + '/proxy?url=' : ''); },
  needs(url) { try { return NEEDS_RELAY.includes(new URL(url).hostname); } catch (e) { return false; } },
  wrap(url, b = this.base()) { if (!b) return null; return b.includes('{url}') ? b.replace('{url}', encodeURIComponent(url)) : b + encodeURIComponent(url); },
  async check() { // a custom relay is test-fetched with one small file; if it fails, the local helper (if any) takes over
    this.checked = true; this.customOk = null;
    if (this.custom) {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 12000);
      try { const r = await fetch(this.wrap('https://www.nhc.noaa.gov/CurrentStorms.json', this.custom), { signal: ctl.signal, cache: 'no-store' }); this.customOk = r.ok; }
      catch (e) { this.customOk = false; } finally { clearTimeout(t); }
      if (this.customOk) { this.available = true; return true; }
    }
    if (!this.local) { this.available = false; return false; }
    try { const r = await fetch(location.origin + '/proxy?ping=1', { cache: 'no-store' }); this.available = r.ok && (await r.text()).trim() === 'ok'; }
    catch (e) { this.available = false; }
    return this.available;
  },
  usingCustom() { return !!(this.custom && this.customOk); },
  status() {
    if (this.custom && this.customOk !== false) return this.customOk ? 'custom relay answering' : 'custom relay set (not tested yet)';
    return (this.custom ? 'custom relay not answering · ' : '') + (this.available ? 'local helper running' : this.local ? 'helper not answering' : 'no helper — open the page through serve.py / serve.js / the .bat file');
  },
};
export const Net = {
  queues: {},
  slot(host, gap) {
    const q = this.queues[host] || (this.queues[host] = { chain: Promise.resolve(), last: 0 });
    const p = q.chain.then(async () => { const wait = q.last + gap - Date.now(); if (wait > 0) await sleep(wait); q.last = Date.now(); });
    q.chain = p.catch(() => { }); return p;
  },
  async fetch(url, { timeout = 25000, headers = {}, throttle = null, gap = 1100, text = false, method = 'GET', body = null } = {}) {
    if (throttle) await this.slot(throttle, gap);
    let target = url, relayed = false;
    if (Relay.needs(url)) { const w = Relay.wrap(url); if (!w) throw new Error('blocked by browser security (CORS) — ' + Relay.status()); target = w; relayed = true; }
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(target, { signal: ctl.signal, headers, method, body, cache: 'no-store', mode: 'cors' });
      if (!r.ok) { let msg = ''; try { msg = (await r.text()).slice(0, 120).replace(/\s+/g, ' '); } catch (e) { } throw new Error('HTTP ' + r.status + (r.status === 429 ? ' rate-limited' : '') + (msg && /^[{\[<]/.test(msg) === false ? ' · ' + msg : '')); }
      return text ? await r.text() : await r.json();
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('timeout');
      if (e instanceof TypeError) throw new Error(relayed ? 'relay unreachable (' + Relay.status() + ')' : 'blocked by browser security (CORS) or offline');
      if (e instanceof SyntaxError) throw new Error('unexpected response (not JSON)');
      throw e;
    } finally { clearTimeout(t); }
  },
  json(url, o) { return this.fetch(url, o); },
  text(url, o = {}) { return this.fetch(url, { ...o, text: true }); },
};

/* ============================================================ clock */
export function tickClock() { const d = new Date(); $('#clockUtc').textContent = d.toISOString().substr(11, 8); $('#clockLocal').textContent = d.toLocaleTimeString([], { hour12: false }); }
setInterval(tickClock, 1000); tickClock();
