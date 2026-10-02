// DOM side of the Solar System view: time controls, layer switches, labels, the details card, search, captions and
// the scale readout. Everything that touches document lives here.
import * as THREE from 'three';
import { LY_AU } from '../core/units.js';
import { REAL_TIME, formatUtc } from '../core/time.js';
import { esc, viewWidth } from '../core/format.js';
import { PHONE } from './util.js';
import { bodies, byKey, layers, layer, layerOn, applyLayers, bodyVisible } from './world.js';
import { BANDS, RUNGS, RUNG_SHORT } from './story.js';

const $ = s => document.querySelector(s);
const RATES = { '-6': -365.25, '-4': -1, '0': 0, '1': REAL_TIME, '4': 1, '5': 30.44, '6': 365.25 };
const RATE_TEXT = { '-6': '1 year per second, backwards', '-4': '1 day per second, backwards', '0': 'paused', '1': 'real time', '4': '1 day per second', '5': '1 month per second', '6': '1 year per second' };

export function createUI({ camera, controls, clock, nav, story, small, deep }) {
  // ---- captions (a "locked" caption, from the tour or a button, isn't overwritten by scale-band captions)
  let capTimer = 0, capLock = 0;
  function caption(t, p, s, ms = 9000, lock = false) {
    if (lock) capLock = performance.now() + ms; else if (performance.now() < capLock) return;
    $('#capT').textContent = t; $('#capP').textContent = p; $('#capS').textContent = s || '';
    $('#cap').classList.remove('hide'); clearTimeout(capTimer); capTimer = setTimeout(() => $('#cap').classList.add('hide'), ms);
  }

  // ---- time
  function syncRate() {
    const k = Object.keys(RATES).find(x => RATES[x] === clock.rate);
    document.querySelectorAll('#time [data-rate]').forEach(b => b.classList.toggle('on', b.dataset.rate === k));
    $('#tRate').textContent = k !== undefined ? RATE_TEXT[k] : Math.round(clock.rate * 86400).toLocaleString('en-US') + '× speed';   // a rate set by the globe
  }
  document.querySelectorAll('#time [data-rate]').forEach(b => { b.onclick = () => { clock.setRate(RATES[b.dataset.rate]); syncRate(); }; });
  $('#now').onclick = () => { clock.goLive(); syncRate(); };

  // ---- layers
  function renderLayers() {
    $('#lys').innerHTML = layers.map(l => `<button class="ly${l.on ? '' : ' off'}${l.sub ? ' sub' : ''}" data-id="${l.id}" style="--c:${l.c}"><i></i><span class="t">${esc(l.name)}</span>${l.n ? `<span class="n">${l.n.toLocaleString('en-US')}</span>` : ''}</button>`).join('');
    document.querySelectorAll('#lys .ly').forEach(b => { b.onclick = () => { const l = layer(b.dataset.id); l.on = !l.on; applyLayers(); renderLayers(); }; });
  }
  $('#menuBtn').onclick = () => $('#dock').classList.toggle('open');

  // ---- buttons
  const tourLabel = on => { $('#bTour').innerHTML = on ? '<b>■</b> Stop the tour' : '<b>▶</b> Guided tour: Earth to Andromeda'; syncRate(); };
  $('#bTour').onclick = () => (story.tour.on ? story.stopTour() : story.startTour());
  $('#bPulse').onclick = () => story.startPulse();
  $('#bAlign').onclick = () => { story.findAlignment(); syncRate(); };
  $('#rungs').innerHTML = RUNGS.map(([label], i) => `<button class="rung" data-i="${i}">${RUNG_SHORT[label] || label}</button>`).join('');
  document.querySelectorAll('.rung').forEach(b => { b.onclick = () => { story.stopTour(); const [, k, d] = RUNGS[+b.dataset.i]; nav.focusOn(byKey[k] || byKey.sun, d, k === 'gc' ? 3 : 2.4, false); }; });

  // ---- details card
  function showCard(b) {
    if (!b) { $('#card').style.display = 'none'; delete $('#card').dataset.key; return; }
    const rows = (b.info ? b.info() : []).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
    $('#cardB').innerHTML = `<div class="k">${esc(b.kind)}</div><h2>${esc(b.name)}</h2><dl>${rows}</dl>${b.fact ? `<p>${esc(b.fact)}</p>` : ''}
      ${b.key === 'earth' ? '<div class="row"><a class="btn" href="globe.html">Land on Earth: 3D globe</a></div>' : ''}`;
    $('#card').style.display = 'block'; $('#card').dataset.key = b.key;
  }
  $('#cardX').onclick = () => showCard(null);
  $('#cardB').addEventListener('click', e => { const a = e.target.closest('a[href="globe.html"]'); if (a && window.OOSS?.embed?.active !== undefined && document.body.classList.contains('embedded')) { e.preventDefault(); window.OOSS.embed.goToEarth(); } });
  setInterval(() => { // live numbers, unless the reader is selecting text
    const k = $('#card').dataset.key, sel = getSelection();
    if (k && byKey[k] && $('#card').style.display !== 'none' && (!sel || sel.isCollapsed)) showCard(byKey[k]);
  }, 1000);

  // ---- labels
  const labelsEl = $('#labels'), els = new Map(), v = new THREE.Vector3();
  const screenOf = p => { v.copy(p).project(camera); return v.z > 1 || v.z < -1 ? null : [(v.x + 1) / 2 * innerWidth, (1 - v.y) / 2 * innerHeight]; };
  function labelFor(b) {
    let el = els.get(b.key); if (el) return el;
    el = document.createElement('div'); el.className = 'lbl' + (b.big ? ' big' : ''); el.textContent = b.name; el.style.setProperty('--lc', b.color);
    el.onclick = e => { e.stopPropagation(); story.stopTour(); nav.focusOn(b); }; labelsEl.appendChild(el); els.set(b.key, el); return el;
  }
  let lastRank = 0;
  function labelShown(b, camSun, camFocus) {
    if (!layerOn('labels') || !bodyVisible(b) || b.launched === false) return false;
    if (b.star) return camSun > 0.3 * LY_AU && b.vis;                              // the brightest few, once out among them
    if (b.here) return camSun > 30 * LY_AU;
    if (b.far) return camSun > 3000 * LY_AU || (b.key === 'gc' && camSun > 800 * LY_AU);
    if (b.key === 'sun') return camSun < 30 * LY_AU;
    if (b.kind === 'moon') return camera.position.distanceTo(byKey.earth.pos) < 0.05;
    if (b.kind === 'planet') return camSun < 3000;
    return camSun < 600 && (b === nav.focus || camera.position.distanceTo(b.pos) < Math.max(10 * camFocus, 3));  // close in: none from far behind
  }
  function updateLabels(camSun, camFocus) {
    if (performance.now() - lastRank > 400) { lastRank = performance.now(); deep.rankStars(camSun); }
    const taken = [];
    for (const b of bodies) {
      const el = labelFor(b); let s = labelShown(b, camSun, camFocus) ? screenOf(b.pos) : null;
      if (s && b !== nav.focus && taken.some(t => Math.abs(t[0] - s[0]) < 60 && Math.abs(t[1] - s[1]) < 14)) s = null;
      if (!s || s[0] < -50 || s[1] < -20 || s[0] > innerWidth + 50 || s[1] > innerHeight + 20) { if (el.style.display !== 'none') el.style.display = 'none'; continue; }
      taken.push(s); el.style.display = ''; el.style.transform = `translate(${(s[0] + 9).toFixed(1)}px, ${(s[1] - 7).toFixed(1)}px)`;
    }
    for (const [key, el] of els) if (!byKey[key]) { el.remove(); els.delete(key); }         // a replaced picked asteroid
  }

  // ---- picking
  let downAt = null;
  const canvas = $('#c');
  canvas.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY]; story.stopTour(); });
  canvas.addEventListener('pointerup', e => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
    let best = null, bd = 18;
    for (const b of bodies) {
      if (!bodyVisible(b) || (els.get(b.key)?.style.display === 'none' && !(b.mesh && b.mesh.visible))) continue;
      const s = screenOf(b.pos); if (!s) continue;
      const d = Math.hypot(s[0] - e.clientX, s[1] - e.clientY); if (d < bd) { bd = d; best = b; }
    }
    if (!best && layerOn('asteroids') && camera.position.length() < 200) best = small.pickAsteroid(e.clientX, e.clientY, clock.jd, screenOf);
    if (best) nav.focusOn(best);
  });

  // ---- search
  let hits = [], sel = 0;
  $('#q').addEventListener('input', () => {
    const q = $('#q').value.trim().toLowerCase(); if (q.length < 2) { $('#hits').style.display = 'none'; return; }
    const out = bodies.filter(b => !b.transient && b.name.toLowerCase().includes(q)).map(b => ({ name: b.name, kind: b.kind, go: () => nav.focusOn(b) }));
    for (const n of small.search(q, 14)) if (out.length < 14 && !out.some(o => o.name === n[2]))
      out.push({ name: n[2], kind: 'asteroid', go: () => { const b = small.asteroidBody(n); if (b) nav.focusOn(b, Math.max(b.pos.length() * 0.15, 0.05)); } });
    hits = out.sort((a, b) => (b.name.toLowerCase().startsWith(q) ? 1 : 0) - (a.name.toLowerCase().startsWith(q) ? 1 : 0)).slice(0, 14); sel = 0;
    $('#hits').innerHTML = hits.map((h, i) => `<button data-i="${i}" class="${i ? '' : 'sel'}">${esc(h.name)}<small>${esc(h.kind)}</small></button>`).join('') || '<div class="note">Nothing found</div>';
    $('#hits').style.display = 'block';
    document.querySelectorAll('#hits button').forEach(b => { b.onclick = () => pick(+b.dataset.i); });
  });
  function pick(i) { const h = hits[i]; if (!h) return; story.stopTour(); h.go(); $('#hits').style.display = 'none'; $('#q').value = ''; $('#q').blur(); }
  $('#q').addEventListener('keydown', e => {
    if (e.key === 'Enter') pick(sel);
    if (e.key === 'Escape') { $('#hits').style.display = 'none'; $('#q').blur(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length; document.querySelectorAll('#hits button').forEach((b, i) => b.classList.toggle('sel', i === sel)); e.preventDefault(); }
  });
  document.addEventListener('click', e => { if (!$('#search').contains(e.target)) $('#hits').style.display = 'none'; });

  // ---- per frame: date, scale readout, band caption, ladder highlight, labels
  let lastDate = 0, band = -1, started = false;
  function frame({ camSun, camFocus }) {
    if (performance.now() - lastDate > 200) { lastDate = performance.now(); $('#tDate').textContent = formatUtc(clock.jd, { suffix: PHONE ? '' : ' UTC' }); syncRate(); }
    $('#sDist').textContent = 'View ' + viewWidth(2 * camFocus * Math.tan(camera.fov * Math.PI / 360) * camera.aspect) + ' wide';
    const f = nav.focus || byKey.sun, close = camFocus < 0.05 && f.key !== 'earth' && f.key !== 'moon';   // close in, name the body instead
    const bi = close ? -2 : BANDS.findIndex(b => camSun < b[0]);
    if (bi !== band || (close && $('#sName').textContent !== f.name)) {
      band = bi;
      if (close) $('#sName').textContent = f.name;
      else { const B = BANDS[bi]; $('#sName').textContent = B[1]; if (started && !story.tour.on && !story.pulse.on) caption(B[2], B[3], B[4]); }
    }
    document.querySelectorAll('.rung').forEach((r, i) => r.classList.toggle('on', bi >= 0 && RUNGS[i][0] === BANDS[bi][1]));
    updateLabels(camSun, camFocus);
  }

  renderLayers(); syncRate();
  return { caption, showCard, renderLayers, tourLabel, frame, start() { started = true; } };
}
