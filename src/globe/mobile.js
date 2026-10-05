// Phone controls for the 3D globe: a bottom dock (Explore, Layers, Time, Look up, North) with sheets that slide up,
// in place of the long scrolling destination band and the six tiny time buttons. Built only when PHONE is true, so
// desktops never see it. It adds no logic of its own: every button clicks the control that already exists
// (#band [data-go], #btnDock, #timebar), so presets, look-up and time stay in one place.
import { $, PHONE, toast } from './env.js';
import { camera } from './viewer.js';
import { state, hooks } from './state.js';
import { Follow } from './follow.js';
import { Share } from './share.js';

const PLACES = {
  ground: ['Street', 'London at 3 km, tilted'], air: ['Airspace', 'Europe from 1,400 km'], earth: ['Earth', 'The whole planet, sunlit side'],
  geo: ['GEO belt', '36,000 km up, where TV satellites sit'], moon: ['Moon', 'Fly out and look at it'], conj: ['Near misses', 'Close approaches in orbit'],
  tour: ['Tour', 'An 80-second guided flight'], launches: ['Launches', 'Rockets about to fly, with countdowns'], flybys: ['Flybys', 'Asteroids passing Earth'], weather: ['Weather', 'Live clouds, rain radar, rain from space'], search: ['Search', 'Satellites, countries, flights, volcanoes'], tonight: ['Tonight', 'What you can see above you, with reminders'], flight: ['Find a flight', 'Type a flight number, follow the plane'], lookup: ['Look up', 'Your sky, with the phone as a window'], eclipses: ['Eclipses', 'Solar eclipses 2027 to 2030'], space: ['Solar System', 'Keep going: planets, stars, galaxies'],
};
const RATES = [[-3600, '« 1 h/s'], [0, '❚❚ Pause'], [1, '▶ Live'], [60, '› 1 min/s'], [600, '» 10 min/s'], [3600, '⏩ 1 h/s']];

export function initMobile() {
  if (!PHONE) return;
  document.body.classList.add('m');
  const band = $('#band'), timebar = $('#timebar');
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

  const scrim = el('div', 'm-scrim'), sheet = el('section', 'm-sheet glass'), dock = el('nav', 'm-dock glass');
  scrim.id = 'mscrim'; sheet.id = 'msheet'; dock.id = 'mdock';
  const TABS = [['explore', 'Explore', '◎'], ['layers', 'Layers', '▤'], ['time', 'Time', '◷'], ['lookup', 'Look up', '✦'], ['north', 'North', '⌖']];
  for (const [k, label, icon] of TABS) { const b = el('button', 'm-tab', `<i>${icon}</i><span>${label}</span>`); b.dataset.tab = k; b.type = 'button'; dock.append(b); }
  document.body.append(scrim, sheet, dock);

  let open = null;
  const tab = k => dock.querySelector(`[data-tab="${k}"]`);
  const sync = () => {   // which tab looks pressed
    tab('explore').classList.toggle('on', open === 'explore'); tab('time').classList.toggle('on', open === 'time');
    tab('layers').classList.toggle('on', $('#dock').classList.contains('open'));
  };
  const close = () => { open = null; sheet.classList.remove('show'); scrim.classList.remove('show'); sync(); };

  function exploreHtml() {
    const alt = `${$('#bandName').textContent} · ${$('#bandAlt').textContent}`;
    const items = [...band.querySelectorAll('[data-go]')].map(b => { const [name, sub] = PLACES[b.dataset.go] || [b.textContent.trim(), '']; return `<button class="m-item${b.classList.contains('on') ? ' on' : ''}" data-go="${b.dataset.go}"><b>${name}</b><span>${sub}</span></button>`; });
    return `<div class="m-head"><b>Go to</b><span>${alt}</span></div><div class="m-grid">${items.join('')}</div><button class="m-item m-now" data-share="1"><b>Copy link to this view</b><span>Same place, layers and time</span></button><button class="m-item m-now" data-embed="1"><b>Put it on a web page</b><span>Copy embed code for this view</span></button><button class="m-item m-now" data-snap="1"><b>Share a picture</b><span>This view with a caption and the link</span></button>`;
  }
  function timeHtml() {
    const cur = timebar.querySelector('[data-rate].on'), now = $('#tNow').textContent, mode = $('#tMode').textContent;
    const rates = RATES.map(([r, label]) => `<button class="m-rate${cur && +cur.dataset.rate === r ? ' on' : ''}" data-rate="${r}">${label}</button>`);
    return `<div class="m-head"><b>${now}</b><span>${mode}</span></div><div class="m-rates">${rates.join('')}</div><button class="m-item m-now" data-now="1"><b>Back to now</b><span>Live time</span></button>`;
  }
  const render = () => { if (open === 'explore') sheet.innerHTML = exploreHtml(); else if (open === 'time') sheet.innerHTML = timeHtml(); };
  function show(k) { open = k; render(); sheet.classList.add('show'); scrim.classList.add('show'); sync(); }

  function northUp() {
    if (Follow.obj || state.lookingAtMoon) { toast('Stop following first, then North works'); return; }
    camera.flyTo({ destination: camera.positionWC.clone(), orientation: { heading: 0, pitch: camera.pitch, roll: 0 }, duration: 0.8 });
  }

  dock.addEventListener('click', e => {
    const b = e.target.closest('[data-tab]'); if (!b) return; const k = b.dataset.tab;
    if (k === 'explore' || k === 'time') { open === k ? close() : (close(), show(k)); return; }
    close();
    if (k === 'layers') { $('#btnDock').click(); sync(); } else if (k === 'lookup') band.querySelector('[data-go="lookup"]').click(); else northUp();
  });
  sheet.addEventListener('click', e => {
    const go = e.target.closest('[data-go]'), share = e.target.closest('[data-share]'), rate = e.target.closest('[data-rate]'), now = e.target.closest('[data-now]');
    if (share) { Share.copy(); close(); return; }
    if (e.target.closest('[data-embed]')) { Share.copyEmbed(); close(); return; }
    if (e.target.closest('[data-snap]')) { close(); hooks.snapshot(); return; }   // the picture is the canvas only: the closing sheet isn't in it
    if (go) { band.querySelector(`[data-go="${go.dataset.go}"]`).click(); close(); }
    else if (rate) { timebar.querySelector(`[data-rate="${rate.dataset.rate}"]`).click(); setTimeout(() => open === 'time' && render(), 50); }
    else if (now) { $('#tLive').click(); setTimeout(() => open === 'time' && render(), 50); }
  });
  scrim.addEventListener('click', close);
  $('#timebar').addEventListener('click', e => { if (!e.target.closest('[data-rate],#tLive') && open !== 'time') { close(); show('time'); } });   // tap the clock
  new MutationObserver(sync).observe($('#dock'), { attributes: true, attributeFilter: ['class'] });
  setInterval(() => {   // keep the clock in the time sheet moving, in place (replacing the buttons would eat a tap in progress)
    if (open !== 'time') return; const h = sheet.querySelector('.m-head'); if (!h) return;
    h.firstChild.textContent = $('#tNow').textContent; h.lastChild.textContent = $('#tMode').textContent;
    const cur = timebar.querySelector('[data-rate].on'); sheet.querySelectorAll('[data-rate]').forEach(b => b.classList.toggle('on', !!cur && +cur.dataset.rate === +b.dataset.rate));
  }, 1000);
}
