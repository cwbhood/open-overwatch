// Search everything the globe knows: satellites (name or NORAD number, plus everyday names like "ISS" or "Hubble"),
// countries, flights (a ticket number goes to the flight finder), volcanoes, big employers and lighthouses once their
// layers have loaded, and the views in the band ("moon", "eclipses", "tonight"...). "/" opens it on a desktop.
import { $, esc, fmt } from './env.js';
import { state, hooks } from './state.js';
import { L, syncDock } from './layers.js';
import { Sats } from './satellites.js';
import { Air } from './aircraft.js';
import { Country } from './country.js';
import { Volcanoes } from './volcanoes.js';
import { Companies } from './companies.js';
import { Lighthouses } from './lighthouses.js';
import { Flight } from './flight.js';
import { Launches } from './launches.js';
import { LookUp } from './lookup.js';
import { select, flyToObject, PRESETS } from './ui.js';
import { parseFlightQuery, matchesFlight } from '../core/flight.js';

// everyday names for famous objects -> NORAD numbers
const ALIAS = { iss: '25544', 'space station': '25544', 'international space station': '25544', zarya: '25544', hubble: '20580', hst: '20580',
  tiangong: '48274', css: '48274', 'chinese space station': '48274', 'landsat 9': '49260', 'landsat 8': '39084', 'sentinel-2a': '40697', 'goes-16': '41866', 'goes 16': '41866', 'goes-18': '51850' };
// views without a band button: [label, sub]
const EXTRA = { crew: ['People in space', 'Who is aboard the ISS and Tiangong right now'] };
const VIEW_WORDS = { crew: 'astronaut astronauts crew people cosmonaut taikonaut who', tonight: 'tonight sky stars above me passes meteor', lookup: 'look up sky', moon: 'moon lunar', eclipses: 'eclipse eclipses', flybys: 'asteroid comet flyby flybys',
  weather: 'weather clouds rain radar wind storm', conj: 'near miss collision conjunction', space: 'solar system planets mars jupiter saturn venus mercury uranus neptune pluto stars galaxy',
  geo: 'geostationary geo belt tv satellites', tour: 'tour guide', launches: 'launch launches rocket spacex nasa artemis falcon starship countdown', flight: 'flight plane aircraft' };

let results = [], timer = 0, seq = 0;

async function find(q) {
  const s = q.trim().toLowerCase(), out = [];
  if (s.length < 2) return out;
  // views in the band
  for (const [go, words] of Object.entries(VIEW_WORDS)) if (words.split(' ').some(w => w.startsWith(s)) || go.startsWith(s)) {
    const b = $(`#band [data-go="${go}"]`); if (b) out.push({ kind: 'view', go, label: b.textContent.trim(), sub: b.title || 'View' }); else if (EXTRA[go]) out.push({ kind: 'view', go, label: EXTRA[go][0], sub: EXTRA[go][1] });
  }
  // flights: a ticket number, callsign, registration or hex
  const fq = /\d/.test(s) && /[a-z]/.test(s) ? parseFlightQuery(q) : null;   // a bare number is a NORAD id, not a flight
  if (fq) {
    const here = [...Air.map.values()].filter(r => matchesFlight(r, fq)).slice(0, 3);
    for (const r of here) out.push({ kind: 'obj', obj: r, label: `✈ ${r.flight || r.hex}`, sub: `${r.reg ? r.reg + ' · ' : ''}${r.ground ? 'on the ground' : fmt((r.alt || 0) / 0.3048) + ' ft'}` });
    if (!here.length && fq.callsigns.length) out.push({ kind: 'flight', q: q.trim(), label: `✈ Find flight ${fq.callsigns[0]}`, sub: 'Look it up and follow it' });
  }
  // launches (by rocket or mission name)
  for (const o of Launches.list.filter(o => o.name.toLowerCase().includes(s)).slice(0, 4)) out.push({ kind: 'obj', obj: o, label: `🚀 ${o.mission}`, sub: `${o.rocket} · ${o.place || o.pad}` });
  // satellites
  const sats = [], alias = ALIAS[s], push = o => { if (o && !sats.includes(o)) sats.push(o); };
  if (alias) push(Sats.byId.get(alias));
  if (/^\d{1,6}$/.test(s)) { push(Sats.byId.get(String(+s))); push(Sats.byId.get(s.padStart(5, '0'))); }   // parseTle keeps the TLE's zero-padded id ("00005")
  const rank = o => (o.layer === 'stations' ? 0 : o.layer === 'visual' ? 1 : o.layer === 'debris' ? 3 : 2) + (o.name.toLowerCase().startsWith(s) ? 0 : 0.5);
  if (s.length >= 3 || !alias) for (const o of Sats.list.filter(o => o.name.toLowerCase().includes(s)).sort((a, b) => rank(a) - rank(b)).slice(0, 8)) push(o);
  for (const o of sats.slice(0, 8)) out.push({ kind: 'obj', obj: o, label: `🛰 ${o.name}`, sub: `NORAD ${o.id} · ${L[o.layer].name.split(' (')[0]}` });
  const starlinks = s.startsWith('starl') ? Sats.list.filter(o => o.layer === 'starlink').length : 0;
  if (starlinks) out.push({ kind: 'note', label: `${fmt(starlinks)} Starlink satellites`, sub: 'Too many to list: type a number, e.g. "Starlink-1007"' });
  // countries
  const seqNow = seq;
  const countries = await Country.search(s).catch(() => []); if (seqNow !== seq) return null;
  for (const c of countries) out.push({ kind: 'country', iso: c.iso, label: `🏳 ${c.name}`, sub: 'Country dossier' });
  // whatever else has loaded
  for (const [list, icon, what] of [[Volcanoes.list, '🌋', 'Volcano'], [Companies.list, '🏢', 'Employer'], [Lighthouses.list, '🗼', 'Lighthouse']]) {
    for (const o of list.filter(o => o.name && o.name.toLowerCase().includes(s)).slice(0, 4)) out.push({ kind: 'obj', obj: o, label: `${icon} ${o.name}`, sub: [what, o.country].filter(Boolean).join(' · ') });
  }
  return out;
}

function draw(list, q) {
  const box = $('#srRes'); if (!box) return;
  results = list;
  box.innerHTML = list.length ? list.map((r, i) => `<button class="cj sr" data-i="${i}"><span>${esc(r.label)}</span><small>${esc(r.sub)}</small></button>`).join('')
    : q.trim().length < 2 ? '<p class="note">Satellites (name or NORAD number), countries, flight numbers, volcanoes, views… Try "ISS", "Japan", "BA 123", "Etna" or "eclipse".</p>'
    : !Sats.list.length ? '<p class="note">The satellite catalogue is still loading: try again in a moment.</p>'
    : `<p class="note">Nothing called "${esc(q.trim())}" on the globe. Volcanoes, employers and lighthouses are searched once their layers are on.</p>`;
}

async function pick(r) {
  if (r.kind === 'view') { const b = $(`#band [data-go="${r.go}"]`); if (b) b.click(); else PRESETS[r.go](); return; }
  if (r.kind === 'flight') { Flight.find(r.q); return; }
  if (r.kind === 'country') { const o = await Country.byIso(r.iso); if (o) { select(o); Country.fly(o); } return; }
  if (r.kind === 'obj') { const o = r.obj, lay = L[o.layer || (o.kind === 'air' ? (o.mil ? 'mil' : 'air') : o.kind === 'volcano' ? 'volcanoes' : o.kind === 'company' ? 'companies' : o.kind === 'launch' ? 'launches' : 'lighthouses')]; if (lay && !lay.on) { lay.on = true; syncDock(); hooks.applyVisibility(); } select(o); flyToObject(o); }
}

export const Search = {
  open(text = '') {
    if (LookUp.active) LookUp.leave();
    const c = $('#card'); hooks.clearSelection?.();
    c.innerHTML = `<button class="x" aria-label="Close">×</button><div class="k" style="--c:#7dffa6">Everything on the globe</div><h2>Search</h2>
      <form class="fl-form" id="srForm" autocomplete="off" role="search"><input id="srQ" maxlength="40" placeholder="ISS · Japan · BA 123 · Etna" aria-label="Search" value="${esc(text)}" style="text-transform:none"></form>
      <div class="cjl" id="srRes" aria-live="polite"></div>`;
    c.classList.add('show'); c.querySelector('.x').onclick = () => c.classList.remove('show');
    const input = c.querySelector('#srQ');
    const run = () => { clearTimeout(timer); timer = setTimeout(async () => { const n = ++seq, q = input.value, list = await find(q); if (list && n === seq) draw(list, q); }, 140); };
    input.oninput = run;
    c.querySelector('#srForm').onsubmit = e => { e.preventDefault(); clearTimeout(timer); (async () => { const n = ++seq, list = await find(input.value); if (list && n === seq) { draw(list, input.value); if (list[0] && list[0].kind !== 'note') pick(list[0]); } })(); };
    c.querySelector('#srRes').onclick = e => { const b = e.target.closest('[data-i]'); if (b && results[+b.dataset.i] && results[+b.dataset.i].kind !== 'note') pick(results[+b.dataset.i]); };
    draw([], text); if (text) run();
    setTimeout(() => input.focus(), 50);
  },
};
