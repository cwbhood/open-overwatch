// The globe's layer switches (remembered per browser) and the dock that shows them.
import { $, esc, fmt, store, PHONE } from './env.js';
import { hooks } from './state.js';

export const LAYERS = [
  { id: 'stations', group: 'Space', name: 'Space stations', color: '#7dffa6', on: true, sat: ['stations'], size: 7 },
  { id: 'visual', group: 'Space', name: 'Bright satellites', color: '#e6edf3', on: true, sat: ['visual'], size: 3.5 },
  { id: 'gnss', group: 'Space', name: 'Navigation (GPS · Galileo · GLONASS · BeiDou)', color: '#ffd45c', on: true, sat: ['gps-ops', 'galileo', 'glo-ops', 'beidou'], size: 4 },
  { id: 'geo', group: 'Space', name: 'Geostationary belt', color: '#b48cff', on: true, sat: ['geo'], size: 3.5 },
  { id: 'weather', group: 'Space', name: 'Weather satellites', color: '#62e0c8', on: true, sat: ['weather'], size: 4 },
  { id: 'starlink', group: 'Space', name: 'Starlink', color: '#d9ccff', on: true, sat: ['starlink'], size: 1.6, alpha: 0.55 },
  // last, so the groups above keep their own objects: every other active satellite CelesTrak lists, then the debris
  // clouds of the 2007 Fengyun-1C test and the 2009 Iridium 33 / Cosmos 2251 collision. (The full catalogue, with every
  // rocket body and fragment, is Space-Track's and may not be redistributed.) Off by default on phones: ~5,000 more dots.
  { id: 'active', group: 'Space', name: 'All other active satellites', color: '#8fb8ff', on: !PHONE, sat: ['active'], size: 2, alpha: 0.75 },
  { id: 'debris', group: 'Space', name: 'Debris (Fengyun-1C, Iridium 33, Cosmos 2251)', color: '#ff6b6b', on: !PHONE, sat: ['fengyun-1c-debris', 'iridium-33-debris', 'cosmos-2251-debris'], size: 1.8, alpha: 0.8 },
  { id: 'air', group: 'Air', name: 'Civil aircraft (OpenSky, every 15 min)', color: '#5fd3ff', on: true },
  { id: 'mil', group: 'Air', name: 'Military aircraft (adsb.lol, every 60 s)', color: '#ffb44d', on: true },
  { id: 'quakes', group: 'Earth', name: 'Earthquakes M2.5+ · 24 h', color: '#ff7b4f', on: true },
  { id: 'lighthouses', group: 'Earth', name: 'Lighthouses of the world', color: '#ffe27a', on: !PHONE },
  { id: 'clouds', group: 'Earth', name: 'Clouds (NASA Blue Marble)', color: '#e6edf3', on: true },
  { id: 'night', group: 'Earth', name: 'City lights on the night side', color: '#fff1d0', on: true },
  { id: 'labels', group: 'Earth', name: 'Place names when close', color: '#8b9bab', on: true },
];
export const L = Object.fromEntries(LAYERS.map(l => [l.id, l]));
for (const l of LAYERS) l.on = store.get('ly.' + l.id, l.on);

export function setCount(id, n) { const el = $('#n-' + id); if (el) el.textContent = n ? fmt(n) : ''; }

/** bases: { id: { name } }, currentBase(): id, onBase(id) */
export function initDock({ bases, currentBase, onBase, quality }) {
  const counts = {};
  function render() {
    for (const l of LAYERS) { const el = $('#n-' + l.id); if (el) counts[l.id] = el.textContent; }
    let html = '', g = '';
    for (const l of LAYERS) {
      if (l.group !== g) { html += (g ? '<div class="sep"></div>' : '') + `<h3>${esc(l.group)}</h3>`; g = l.group; }
      html += `<button class="ly ${l.on ? '' : 'off'}" data-ly="${l.id}" style="--c:${l.color}"><i></i><span class="t">${esc(l.name)}</span><span class="n" id="n-${l.id}">${esc(counts[l.id] || '')}</span></button>`;
    }
    html += '<div class="sep"></div><h3>Base map</h3>' + Object.entries(bases).map(([id, b]) => `<button class="ly ${currentBase() === id ? '' : 'off'}" data-base="${id}" style="--c:#e6edf3"><i></i><span class="t">${esc(b.name)}</span></button>`).join('');
    if (quality) {
      const auto = quality.chosen() === 'auto';
      html += '<div class="sep"></div><h3>Graphics</h3>' + [['auto', `Auto (${quality.levels[quality.current()].name.toLowerCase()})`], ...Object.entries(quality.levels).map(([id, q]) => [id, q.name])]
        .map(([id, name]) => `<button class="ly ${(auto ? id === 'auto' : id === quality.chosen()) ? '' : 'off'}" data-q="${id}" style="--c:#e6edf3"><i></i><span class="t">${esc(name)}</span></button>`).join('');
    }
    html += '<div class="sep"></div><button class="ly" data-nerd="1" style="--c:#ffd27a"><i></i><span class="t">Under the hood: speed, data age, accuracy</span></button>';
    html += '<p class="note">Drag to orbit, scroll to zoom, right-drag to tilt. Click anything for details.</p>';
    $('#dock').innerHTML = html;
  }
  render();
  $('#dock').addEventListener('click', e => {
    const b = e.target.closest('[data-ly]'), base = e.target.closest('[data-base]'), q = e.target.closest('[data-q]');
    if (base) { onBase(base.dataset.base); render(); return; }
    if (q) { quality.choose(q.dataset.q); render(); return; }
    if (e.target.closest('[data-nerd]')) { hooks.toggleNerd?.(); return; }
    if (!b) return;
    const l = L[b.dataset.ly]; l.on = !l.on; store.set('ly.' + l.id, l.on); b.classList.toggle('off', !l.on); hooks.applyVisibility();
  });
  $('#btnDock').addEventListener('click', () => $('#dock').classList.toggle('open'));
}
