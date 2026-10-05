// "Tonight above you": what is in your own sky over the next 24 hours, in plain words. The space stations and Hubble
// when they pass in sunlight against a dark sky, Starlink launches still flying as a train, the brightest other
// satellites when they climb high, the bright planets, the Moon's phase and the aurora chance where you stand. Each
// pass can become a calendar reminder (works with the site closed) or a notification (while the page is open).
// Your location is used here and saved only on this device (rounded to ~1 km), so the next visit can say it straight away.
import { C, $, esc, toast, store } from './env.js';
import { state } from './state.js';
import { Sats } from './satellites.js';
import { sunDirection } from './earth.js';
import { Aurora } from './aurora.js';
import { Alerts } from './alerts.js';
import { LookUp, observerAt } from './lookup.js';
import { findPasses, compass } from '../core/passes.js';
import { showersFor } from '../core/meteors.js';
import { planetsTonight, moonPhase, auroraAt, describePass, starlinkTrains, sunAlt } from '../core/sky.js';

const HOUR = 3600e3, DAY = 24 * HOUR;
const MAIN = [['25544', 'ISS (International Space Station)', 'ISS'], ['48274', "Tiangong (China's space station)", 'Tiangong'], ['20580', 'Hubble Space Telescope', 'Hubble']];
const time = ms => {
  const d = new Date(ms), t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? t : d.toLocaleDateString([], { weekday: 'short' }) + ' ' + t;
};
// catalogue names, made readable: "SL-16 R/B" is the spent upper stage of a Zenit rocket, bright because it is big
const friendly = n => / R\/B$/.test(n) ? `${n.replace(/ R\/B$/, '')} rocket stage` : / DEB$/.test(n) ? `${n.replace(/ DEB$/, '')} debris` : n;
const breathe = () => new Promise(r => setTimeout(r, 0));

const home = {
  get: () => store.get('home', null),
  set: (lat, lon) => store.set('home', { lat: +lat.toFixed(2), lon: +lon.toFixed(2) }),
  forget: () => { try { localStorage.removeItem('oo3d.home'); localStorage.removeItem('oo3d.auroraWatch'); } catch (e) { /* private mode */ } },
};
const locate = () => new Promise(res => {
  if (!navigator.geolocation) return res(null);
  navigator.geolocation.getCurrentPosition(p => res(p.coords), () => res(null), { timeout: 10000, maximumAge: 600e3 });
});
async function satsReady(ms = 40e3) {
  const t0 = Date.now();
  while (!(Sats.list.length && window.satellite) && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 400));
  return Sats.list.length > 0 && !!window.satellite;
}

/** Passes of one satellite (Sats entry) over the observer between t0 and t1. */
function passesOf(s, obs, t0, t1, step = 30e3) {
  const sl = window.satellite, rec = s.rec || (s.rec = sl.twoline2satrec(s.l1, s.l2));
  const at = ms => { const d = new Date(ms), pv = sl.propagate(rec, d); if (!pv.position || isNaN(pv.position.x)) return null; const f = sl.eciToEcf(pv.position, sl.gstime(d)); return { x: f.x, y: f.y, z: f.z }; };
  return findPasses(at, obs.km, t0, t1, { step, sunAt: ms => sunDirection(C.JulianDate.fromDate(new Date(ms))) });
}

const S = { open: false, run: 0, loc: null, passes: [], aurora: null };

function card(html) { const c = $('#card'); state.selected = null; c.innerHTML = `<button class="x" aria-label="Close">×</button>${html}`; c.classList.add('show'); c.querySelector('.x').onclick = () => Tonight.close(); return c; }

function intro(msg = '') {
  const c = card(`<div class="k" style="--c:#7dffa6">Your sky</div><h2>Tonight above you</h2>
    <p class="note">The space station, Starlink trains, bright planets, the Moon and the aurora chance where you are, in plain words, with reminders.</p>
    ${msg ? `<p class="note warn">${esc(msg)}</p>` : ''}
    <div class="acts"><button class="chipbtn" id="tnLoc" style="color:#7dffa6">Use my location</button><button class="chipbtn" id="tnGreen">Try Greenwich</button></div>
    <p class="note">Your location is used on this device only (saved rounded to about 1 km, so the next visit can tell you straight away). It is never sent anywhere.</p>`);
  c.querySelector('#tnLoc').onclick = async () => {
    c.querySelector('#tnLoc').textContent = 'Finding you…';
    const p = await locate(); if (!p) return intro('Location was refused or unavailable. You can try Greenwich instead, or allow location for this site.');
    home.set(p.latitude, p.longitude); show(home.get());
  };
  c.querySelector('#tnGreen').onclick = () => show({ lat: 51.48, lon: 0, demo: true });
}

const passRow = (p, i) => `<div class="tn-row"><span>${esc(describePass(p.name, p, { time }))}</span><span class="tn-b"><button class="chipbtn" data-rem="${i}" title="A notification 10 minutes before, while this page is open">Remind me</button><button class="chipbtn" data-cal="${i}" title="A calendar event with a reminder: works with the site closed">Calendar</button></span></div>`;

function render(initial = false) {
  if (!S.open || !S.loc) return;
  const cur = $('#card');   // closed, or replaced by another card (Esc, a click on the globe): stop updating it
  if (!initial && !(cur.classList.contains('show') && cur.querySelector('.tn-head'))) { S.open = false; S.run++; return; }
  const { lat, lon, demo } = S.loc, now = Date.now(), list = S.passes.filter(p => p.set > now).sort((a, b) => a.rise - b.rise);
  const planets = planetsTonight(lat, lon, now, { time }), up = planets.filter(p => p.up), moon = moonPhase(now);
  const first = list.find(p => p.visible), sky = sunAlt(lat, lon, now);
  const showers = showersFor(lat, lon, now, { time }).filter(m => m.days > -2 || m.rate >= 3);   // drop the long faint tails
  const head = [first ? `Next to see: <b>${esc(first.short)} at ${esc(time(first.rise))}</b>, look ${esc(compass(first.azRise))}.` : S.computing ? 'Working out the passes…' : 'No bright satellite passes in a dark sky in the next 24 hours.',
    up.length ? `${esc(up.map(p => p.name).join(', '))} ${up.length > 1 ? 'are' : 'is'} up tonight.` : '',
    S.aurora && S.aurora.level >= 2 ? `<b class="ok">${esc(S.aurora.text)}</b>` : ''].filter(Boolean).join(' ');
  const watching = !!store.get('auroraWatch', null);
  const c = card(`<div class="k" style="--c:#7dffa6">${demo ? 'Greenwich, London (example)' : `Your sky · ${lat.toFixed(2)}, ${lon.toFixed(2)} · on this device only`}</div><h2>Tonight above you</h2>
    <p class="tn-head">${head}</p>
    <h3>Satellites you can see${S.computing ? ' <small>· still searching…</small>' : ''}</h3>
    <div class="tn-list">${list.filter(p => p.visible).map(p => passRow(p, S.passes.indexOf(p))).join('') || '<p class="note">None in sunlight against a dark sky in the next 24 hours. Passes in daylight happen, but you can\'t see them.</p>'}</div>
    <h3>Planets</h3><div class="tn-list">${planets.map(p => `<div class="tn-row${p.up ? '' : ' dim'}"><span>${esc(p.text)}</span></div>`).join('')}</div>
    ${showers.length ? `<h3>Meteor showers</h3><div class="tn-list">${showers.map((m, i) => `<div class="tn-row"><span>${esc(m.text)}</span>${m.radiantAlt >= 10 && m.days > 0.75 ? `<span class="tn-b"><button class="chipbtn" data-met="${i}" title="A calendar event for the best time on the peak night">Calendar</button></span>` : ''}</div>`).join('')}</div>` : ''}
    <h3>Moon</h3><p class="tn-p">${esc(moon.name)} · ${Math.round(moon.lit * 100)}% lit${sky > 0 ? ' · it is daytime here now' : ''}</p>
    <h3>Aurora</h3><p class="tn-p">${S.aurora ? esc(S.aurora.text) + ` <small>(NOAA OVATION: ${S.aurora.overhead}% overhead)</small>` : 'Checking NOAA\'s aurora forecast…'}</p>
    <div class="acts"><button class="chipbtn" id="tnAur">${watching ? 'Stop aurora alerts' : 'Alert me if aurora gets likely'}</button></div>
    <div class="acts"><button class="chipbtn" id="tnLook" style="color:#7dffa6">Look up</button>${demo ? '<button class="chipbtn" id="tnLoc">Use my location</button>' : '<button class="chipbtn" id="tnForget">Forget my location</button>'}</div>
    <p class="note">Times are yours (${esc(Intl.DateTimeFormat().resolvedOptions().timeZone || 'local')}). "Calendar" adds an event that reminds you 10 minutes before, even with this site closed. "Remind me" and aurora alerts work while this page is open in a tab.</p>`);
  c.querySelectorAll('[data-rem]').forEach(b => { b.onclick = () => { const p = S.passes[+b.dataset.rem]; Alerts.remind({ tag: `pass-${p.id}-${Math.round(p.rise / 60e3)}`, at: p.rise - 10 * 60e3, title: `${p.short} in 10 minutes`, body: describePass(p.short, p, { time }) }); }; });
  c.querySelectorAll('[data-cal]').forEach(b => { b.onclick = () => { const p = S.passes[+b.dataset.cal]; Alerts.calendar([{ uid: `oo-${p.id}-${Math.round(p.rise / 60e3)}@open-overwatch`, start: p.rise, end: p.set, title: `${p.short} passes over: look ${compass(p.azRise)}`, details: describePass(p.name, p, { time }) + '\nhttps://cwbhood.github.io/open-overwatch/globe.html#go=tonight', alarmMin: 10 }], `${p.short.toLowerCase().replace(/\W+/g, '-')}-pass.ics`); }; });
  c.querySelectorAll('[data-met]').forEach(b => { b.onclick = () => {
    const m = showers[+b.dataset.met], night = showersFor(lat, lon, m.peakMs - 12 * HOUR, { time }).find(x => x.name === m.name), at = (night && night.bestMs) || m.peakMs;
    Alerts.calendar([{ uid: `oo-${m.name.replace(/\W+/g, '')}-${new Date(m.peakMs).getUTCFullYear()}@open-overwatch`, start: at - HOUR, end: at + HOUR, title: `${m.name} meteor shower: look up (radiant ${m.dir})`, details: `${m.text}\nFrom ${m.parent}, hitting the air at ${m.kms} km/s. Get away from lights, give your eyes 20 minutes, lie back.\nhttps://cwbhood.github.io/open-overwatch/globe.html#go=tonight`, alarmMin: 30 }], `${m.name.toLowerCase().replace(/\W+/g, '-')}.ics`);
  }; });
  c.querySelector('#tnAur').onclick = async () => {
    if (watching) { try { localStorage.removeItem('oo3d.auroraWatch'); } catch (e) { /* private mode */ } toast('Aurora alerts off'); return render(); }
    if (!(await Alerts.permission())) return toast('Notifications are blocked or not supported in this browser', 4000);
    store.set('auroraWatch', { lat, lon }); toast('Aurora alerts on: checked every 10 minutes while this page is open, once a night at most', 5000); render(); Tonight.watchAurora();
  };
  c.querySelector('#tnLook').onclick = () => { Tonight.close(); LookUp.enter(); };
  if (c.querySelector('#tnForget')) c.querySelector('#tnForget').onclick = () => { home.forget(); toast('Location forgotten'); intro(); };
  if (c.querySelector('#tnLoc')) c.querySelector('#tnLoc').onclick = async () => { const p = await locate(); if (p) { home.set(p.latitude, p.longitude); show(home.get()); } else toast('Location refused or unavailable', 4000); };
}

async function show(loc) {
  const run = ++S.run; S.open = true; S.loc = loc; S.passes = []; S.aurora = null; S.computing = true; render(true);
  const obs = observerAt(loc.lat, loc.lon), t0 = Date.now(), t1 = t0 + DAY;
  Aurora.grid().then(g => { if (run === S.run) { S.aurora = auroraAt(g.coordinates, loc.lat, loc.lon); render(); } }, () => { if (run === S.run) { S.aurora = { level: 0, overhead: 0, text: 'NOAA\'s aurora forecast is unreachable right now.' }; render(); } });
  if (!(await satsReady())) { S.computing = false; render(); return; }
  const add = (s, name, short, ps) => { for (const p of ps) S.passes.push({ ...p, id: s.id, name, short }); };
  for (const [id, name, short] of MAIN) { const s = Sats.byId.get(id); if (s) add(s, name, short, passesOf(s, obs, t0, t1)); }
  if (run !== S.run) return; render(); await breathe();
  for (const t of starlinkTrains(Sats.list.filter(s => s.layer === 'starlink')).slice(0, 3)) {
    const s = Sats.byId.get(t.sat.id) || t.sat; add(s, `Starlink train (launched ${t.launch}, ${t.count} satellites in a line)`, 'Starlink train', passesOf(s, obs, t0, t1)); await breathe();
  }
  if (run !== S.run) return; render();
  // the brightest other satellites, only when they climb high in a dark sky (a coarser search: there are ~150 of them)
  const bright = [];
  for (const s of Sats.list.filter(x => x.layer === 'visual' && !MAIN.some(([id]) => id === x.id)).slice(0, 90)) {
    for (const p of passesOf(s, obs, t0, t1, 60e3)) if (p.visible && p.maxEl >= 45) bright.push([p, s]);
    await breathe(); if (run !== S.run) return;
  }
  bright.sort((a, b) => b[0].maxEl - a[0].maxEl);
  const seen = new Set(); for (const [p, s] of bright) { if (seen.has(s.id) || seen.size >= 4) continue; seen.add(s.id); add(s, `${friendly(s.name)} (bright satellite)`, friendly(s.name), [p]); }
  S.computing = false; render();
}

export const Tonight = {
  open() { S.open = true; const h = home.get(); if (h) show(h); else intro(); },
  close() { S.open = false; S.run++; $('#card').classList.remove('show'); },
  /** After boot: if this device has a saved location, say the next thing worth seeing in one line. */
  async peek() {
    Alerts.init(); this.watchAurora();
    const h = home.get(); if (!h || !(await satsReady(60e3))) return;
    const iss = Sats.byId.get('25544'); if (!iss || S.open) return;
    const p = passesOf(iss, observerAt(h.lat, h.lon), Date.now(), Date.now() + DAY).find(x => x.visible);
    if (p) toast(`Tonight over you: the ISS at ${time(p.rise)}, look ${compass(p.azRise)} · tap "Tonight" for more`, 8000);
  },
  /** Aurora alerts: while the page is open, every 10 minutes, at most once in 6 hours, only when it is dark. */
  watchAurora() {
    if (this._aw) return;
    const check = async () => {
      const w = store.get('auroraWatch', null); if (!w) return;
      const now = Date.now(); if (sunAlt(w.lat, w.lon, now) > -12 || now - store.get('auroraSaid', 0) < 6 * HOUR) return;
      const a = auroraAt((await Aurora.grid()).coordinates, w.lat, w.lon);
      if (a.level >= 2) { store.set('auroraSaid', now); Alerts.now('Aurora likely now', a.text, 'aurora'); }
    };
    this._aw = setInterval(() => check().catch(e => console.warn('aurora watch', e)), 10 * 60e3); check().catch(() => {});
  },
};
