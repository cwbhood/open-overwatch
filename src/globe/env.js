// Page-level helpers for the 3D globe: Cesium (a global from its UMD build), DOM shortcuts, storage and network.
export const C = window.Cesium;
export const $ = s => document.querySelector(s);
export { esc } from '../core/format.js';
export const fmt = n => n == null || Number.isNaN(n) ? '—' : Math.round(n).toLocaleString('en-US');
export const PHONE = matchMedia('(max-width: 820px)').matches;
export const ON_SITE = location.hostname === 'cwbhood.github.io';
/** Model option: no per-model dynamic environment map. Cesium renders an atmosphere cube map for every model as it
 *  moves, and the specular term adds a shader variant per height band; on small models the reflections don't show. */
export const NO_ENV_MAP = Object.freeze({ enabled: false });

let toastTimer = 0;
export function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/** Small settings in localStorage (prefixed). */
export const store = {
  get(k, d) { try { const v = localStorage.getItem('oo3d.' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('oo3d.' + k, JSON.stringify(v)); return true; } catch (e) { return false; } },
};
/**
 * Large caches (a Starlink TLE group is ~1.3 MB, the OpenSky snapshot more) go to Cache Storage: localStorage caps at
 * ~5 MB, and a failed write would mean downloading again and getting refused by CelesTrak's once-per-2-hours rule.
 */
export const bigStore = {
  async get(k) { try { const r = await (await caches.open('oo3d')).match('/__oo3d/' + k); return r ? await r.json() : store.get(k, null); } catch (e) { return store.get(k, null); } },
  async set(k, v) { try { await (await caches.open('oo3d')).put('/__oo3d/' + k, new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } })); return true; } catch (e) { return store.set(k, v); } },
};

// the local helper (serve.js / serve.py) relays the few feeds that send no CORS headers; the website has no helper
export const RELAY = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) && location.protocol.startsWith('http') ? location.origin + '/proxy?url=' : null;

async function request(url, timeout, read) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeout);
  try { const r = await fetch(url, { signal: ctl.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await read(r); }
  catch (e) { throw e.name === 'AbortError' ? new Error('timeout') : e; }
  finally { clearTimeout(t); }
}
export function getJSON(url, { relay = false, timeout = 45000 } = {}) {
  if (relay && !RELAY) return Promise.reject(new Error('live aircraft need the download version (its local helper relays them)'));
  return request(relay ? RELAY + encodeURIComponent(url) : url, timeout, r => r.json());
}
export const getText = (url, { timeout = 90000 } = {}) => request(url, timeout, r => r.text());

/** Resolves with a loaded <img>. A texture Cesium can't load stops its render loop for good, so textures go through this first. */
export const loadImage = src => new Promise((resolve, reject) => {
  const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('could not load ' + src)); i.src = src;
});
