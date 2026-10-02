// Selection, the details panel, tracks, hover tips, tabs and mobile sheets.
import { $, $$, C, debounce, esc, fmt, isHttp, late, Log, PHONE, Sound, throttle } from './util.js';
import { map } from './mapview.js';
import { Dyn, Sel, glyphs, requestDraw } from './engine.js';

/* ============================================================ selection + detail panel */
export const Detail = {
  el: null,
  show(kind, obj, id) { Sel.kind = kind; Sel.obj = obj; Sel.id = id ?? obj.id ?? obj.hex; this.render(); showTab('detail'); if (PHONE.matches) openSheet('panel'); requestDraw(); },
  live() { // moving-object feeds replace their objects on each update: follow the selection to the newest copy (kept if it is gone)
    const id = Sel.id, o = Sel.obj; let n = null;
    if (Sel.kind === 'air') n = Dyn.air.get(id);
    else if (Sel.kind === 'sat') n = late.Sats.byId.get(id);
    else if (Sel.kind === 'balloon') n = Dyn.balloons.get(id);
    else if (Sel.kind === 'ship') { for (const s of Dyn.ships.values()) if (s.id === id && s.src === o.src) { n = s; break; } }
    if (n) Sel.obj = n; return Sel.obj;
  },
  clear() { Sel.kind = null; Sel.obj = null; Sel.id = null; this.el.innerHTML = '<div class="empty"><b>Nothing selected.</b><br>Tap an aircraft, satellite, ship, camera, quake or event on the map. Tap open ground for a probe: weather, place, sun and an OSM scan of the area.</div>'; requestDraw(); Tracks.clear(); },
  render() { if (!Sel.kind) return; const r = Detail.renderers[Sel.kind]; if (r) this.el.innerHTML = `<a class="backlink" href="#" onclick="showTab('brief');return false">← Brief</a>` + r(this.live()); },
  renderers: {},
  head(color, kicker, title, sub, flags = []) { if (!/^[#\w(),.%\s-]+$/.test(String(color))) color = C.ink_faint; // a plain CSS colour only: it goes into a style attribute
    return `<div class="kicker"><span class="sw" style="background:${color}"></span><span class="label">${esc(kicker)}</span></div><h2>${esc(title)}</h2>${sub ? `<div class="sub">${sub}</div>` : ''}${flags.length ? `<div class="flags">${flags.map(f => `<span class="flag ${f.cls || ''}">${esc(f.t)}</span>`).join('')}</div>` : ''}`; },
  kv(rows) { return `<dl class="kv">${rows.filter(r => r && r[1] != null && r[1] !== '' && r[1] !== '—').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`; }, // values are plain text, escaped here
  links(items) { return `<ul class="links">${items.filter(i => isHttp(i.url)).map(i => `<li><a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.text)}</a>${i.sub ? `<small>${esc(i.sub)}</small>` : ''}</li>`).join('')}</ul>`; },
};
setInterval(() => { // live panels refresh every 2 s, but not while the user is selecting text in them (a re-render would drop it)
  const ts = getSelection(); if (ts && !ts.isCollapsed && Detail.el.contains(ts.anchorNode)) return;
  if (Sel.kind && ['air', 'sat', 'ship', 'balloon'].includes(Sel.kind) && $('#tab-detail').classList.contains('on') && !document.hidden) Detail.render();
}, 2000);
window.flyTo = (lat, lon, z) => { map.flyTo([lat, lon], Math.max(map.getZoom(), z || 6), { duration: 0.8 }); };
export const Tracks = { group: L.layerGroup().addTo(map), clear() { this.group.clearLayers(); } };

/* ---- hover tooltip + click hit testing on the canvas */
export const Hover = {
  el: null, last: null,
  move(e) {
    const h = glyphs.hitTest(e.containerPoint); const mapEl = $('#map');
    if (!h) { if (this.last) { this.el.style.display = 'none'; mapEl.classList.remove('hit'); this.last = null; } return; }
    this.last = h; mapEl.classList.add('hit');
    const kindName = { air: 'Aircraft', sat: 'Satellite', ship: 'Vessel', balloon: 'Balloon', cam: 'Camera', quake: 'Quake', event: 'Event', gdacs: 'Alert', news: 'News', storm: 'Storm', fire: 'Fire', landing: 'Landing station', osm: 'OSM', cluster: 'Ships' }[h.kind] || h.kind;
    this.el.innerHTML = `<span class="k">${esc(kindName)}</span>${esc(h.tip || '')}`; this.el.style.display = 'block';
    const stage = $('#stage').getBoundingClientRect(), rect = mapEl.getBoundingClientRect(); let x = rect.left - stage.left + e.containerPoint.x + 14, y = rect.top - stage.top + e.containerPoint.y + 14;
    if (x + this.el.offsetWidth > stage.width - 8) x = rect.left - stage.left + e.containerPoint.x - this.el.offsetWidth - 10; if (y + this.el.offsetHeight > stage.height - 8) y -= this.el.offsetHeight + 24;
    this.el.style.left = x + 'px'; this.el.style.top = y + 'px';
  },
};
map.on('mousemove', throttle(e => { Hover.move(e); const h = $('#hudPos'); if (h) h.textContent = `${fmt.ll(e.latlng.lat, ((e.latlng.lng + 540) % 360) - 180)} · Z${map.getZoom().toFixed(1)}`; }, 40));
map.on('zoomend', () => { const h = $('#hudPos'); if (h) h.textContent = `${fmt.ll(map.getCenter().lat, ((map.getCenter().lng + 540) % 360) - 180)} · Z${map.getZoom().toFixed(1)}`; });
map.on('mouseout', () => { if (Hover.el) { Hover.el.style.display = 'none'; $('#map').classList.remove('hit'); Hover.last = null; } });
map.on('click', e => {
  const h = glyphs.hitTest(e.containerPoint);
  if (h) { if (h.kind === 'cluster') { map.flyTo([h.obj.lat, h.obj.lon], h.obj.z, { duration: .8 }); return; } Detail.show(h.kind, h.obj); return; }
  if (typeof late.cableHit === 'function') { const c = late.cableHit(e.latlng); if (c) { Detail.show('cable', c.properties, c.properties.id); return; } }
  late.Probe.open(e.latlng);
});

/* ============================================================ tabs + sheets */
export function showTab(id) { $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === id)); $$('.tab').forEach(t => t.classList.toggle('on', t.id === 'tab-' + id)); if (id === 'log') { Log.unread = 0; $('#logCount').textContent = ''; } if (id === 'brief' && window.OW) late.Brief.render(); } // Brief is a const (never a window property); window.OW = INIT done
$$('.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
export function openSheet(which) { $('#rail').classList.toggle('hidden', which !== 'rail'); $('#panel').classList.toggle('hidden', which !== 'panel'); $$('#mobilebar button').forEach(b => b.classList.toggle('on', b.dataset.sheet === which)); setTimeout(() => map.invalidateSize(), 50); }
$$('#mobilebar button').forEach(b => b.addEventListener('click', () => openSheet(b.dataset.sheet)));
export function applyLayoutMode() { if (PHONE.matches) { openSheet('none'); } else { $('#rail').classList.remove('hidden'); $('#panel').classList.remove('hidden'); } setTimeout(() => map.invalidateSize(), 50); }
window.addEventListener('resize', debounce(applyLayoutMode, 150));
try { new ResizeObserver(debounce(() => { map.invalidateSize(); requestDraw(); }, 100)).observe($('#map')); } catch (e) { } // embedded panes can size the map after load
setInterval(() => { const el = $('#map'); const sz = map._size; if (!sz || el.clientWidth !== sz.x || el.clientHeight !== sz.y) { map.invalidateSize({ pan: false }); requestDraw(); } }, 1500); // belt and braces for webviews that skip resize events
$('#btnLogClear').addEventListener('click', () => { Log.el.innerHTML = ''; });
$('#btnSound').addEventListener('click', () => Sound.toggle());
