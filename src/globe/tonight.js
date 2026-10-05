// "Tonight above you": what is in your own sky over the next 24 hours, in plain words. The space stations and Hubble
// when they pass in sunlight against a dark sky, Starlink launches still flying as a train, the brightest other
// satellites when they climb high, the bright planets, the Moon's phase and the aurora chance where you stand. Each
// pass can become a calendar reminder (works with the site closed) or a notification (while the page is open).
// Your location is used here and saved only on this device (rounded to ~1 km), so the next visit can say it straight away.
import { $, esc, toast, store } from './env.js';
import { state } from './state.js';
import { Alerts } from './alerts.js';
import { observer, sunEcef } from '../core/observer.js';
import { findPasses, compass } from '../core/passes.js';
import { showersFor } from '../core/meteors.js';
import { Crew } from './crew.js';
import { oceanAt } from '../core/explain.js';
import { haversine } from '../core/geo.js';
import { planetsTonight, darkWindow, moonPhase, auroraAt, describePass, starlinkTrains, sunAlt, riseSet, nextFullMoon, craftAt, meetings } from '../core/sky.js';
import { fetchAsset } from '../core/assets.js';
import { hoursOf, cloudAt, night, sky as skyWord } from '../core/clouds.js';
import { earthPosition } from '../core/planets.js';
import { jdFromMs } from '../core/time.js';

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
  set: (lat, lon) => { const h = { lat: +lat.toFixed(2), lon: +lon.toFixed(2) }; store.set('home', h); return h; },   // works even when storage is blocked
  forget: () => { try { localStorage.removeItem('oo3d.home'); localStorage.removeItem('oo3d.auroraWatch'); } catch (e) { /* private mode */ } },
};
const locate = () => new Promise(res => {
  if (!navigator.geolocation) return res(null);
  navigator.geolocation.getCurrentPosition(p => res(p.coords), () => res(null), { timeout: 10000, maximumAge: 600e3 });
});
async function satsReady(ms = 40e3) {
  const t0 = Date.now();
  if (D.sats.ready) await Promise.race([D.sats.ready, new Promise(r => setTimeout(r, ms))]);   // a page that says when all groups are in
  while (!(D.sats.list.length && window.satellite) && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 400));
  return D.sats.list.length > 0 && !!window.satellite;
}

/** Passes of one satellite (Sats entry) over the observer between t0 and t1. */
function passesOf(s, obs, t0, t1, step = 30e3) {
  const sl = window.satellite, rec = s.rec || (s.rec = sl.twoline2satrec(s.l1, s.l2));
  const at = ms => { const d = new Date(ms), pv = sl.propagate(rec, d); if (!pv.position || isNaN(pv.position.x)) return null; const f = sl.eciToEcf(pv.position, sl.gstime(d)); return { x: f.x, y: f.y, z: f.z }; };
  return findPasses(at, obs, t0, t1, { step, sunAt: sunEcef });
}

const S = { open: false, run: 0, loc: null, passes: [], aurora: null, iss: '', launches: [], far: [], hours: null, cloudErr: '' };
// cloud forecast: Open-Meteo (CC BY 4.0, free, no key, sends CORS), for a point rounded to 0.1 deg (~10 km), cached an hour
const forecasts = new Map();
async function forecast(lat, lon) {
  const la = lat.toFixed(1), lo = lon.toFixed(1), k = la + ',' + lo, hit = forecasts.get(k);
  if (hit && Date.now() - hit.at < 3600e3) return hit.hours;
  const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}&hourly=cloud_cover,precipitation_probability&forecast_days=4&timezone=GMT&timeformat=unixtime`);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const hours = hoursOf(await r.json()); forecasts.set(k, { at: Date.now(), hours }); return hours;
}
/** Tonight's clouds in words, and the next clear night if tonight isn't. */
function cloudText(lat, lon, now) {
  const H = S.hours; if (!H || !H.length) return null;
  const win = darkWindow(lat, lon, now); if (!win) return null;
  const n = night(H, Math.max(win.start, now), win.end, { time }); if (!n) return null;
  let next = '';
  if (!n.clear.length) for (let d = 1; d <= 3 && !next; d++) {
    const w = darkWindow(lat, lon, win.end + (d - 1) * DAY + 6 * HOUR); if (!w) break;
    const m = night(H, w.start, w.end, { time }); if (m && m.clear.length) next = `Next clear spell: ${new Date(m.clear[0].from).toLocaleDateString([], { weekday: 'long' })} night from ${time(m.clear[0].from)}.`;
  }
  return { ...n, next };
}
const day = ms => { const d = new Date(ms), t = new Date(); return d.toDateString() === t.toDateString() ? 'today' : d.toDateString() === new Date(t.getTime() + DAY).toDateString() ? 'tomorrow' : d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' }); };

/** The Sun and Moon over the next day, in words. */
function sunMoon(lat, lon, now) {
  const sun = riseSet('sun', lat, lon, now), dusk = riseSet('sun', lat, lon, now, { h0: -6 }), dark = riseSet('sun', lat, lon, now, { h0: -18 }), moon = riseSet('moon', lat, lon, now, { h0: 0.125 });
  const sunText = sun.up === true ? 'The Sun stays up all day and night here (midnight Sun).' : sun.up === false ? 'The Sun stays down all day here (polar night).'
    : [sun.set && `Sunset ${time(sun.set)}`, dusk.set && `dark enough for satellites ${time(dusk.set)}`, dark.set ? `fully dark ${time(dark.set)}` : dark.up === false ? 'fully dark all night' : 'never fully dark tonight (summer twilight)', sun.rise && `sunrise ${time(sun.rise)}`].filter(Boolean).join(' · ');
  const moonText = moon.up === true ? 'up all day and night' : moon.up === false ? 'below the horizon all day' : [moon.rise && `rises ${time(moon.rise)}`, moon.set && `sets ${time(moon.set)}`].filter(Boolean).join(' · ');
  const fm = nextFullMoon(now);
  return { sunText, moonText, full: `Next full Moon: ${day(fm.at)}, ${new Date(fm.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · the ${fm.name}${fm.supermoon ? ' (a supermoon: ' + Math.round(fm.km).toLocaleString('en-US') + ' km away, extra big and bright)' : ''}` };
}
const SILENT = { 'Pioneer 10': 2003, 'Pioneer 11': 1995 };   // last contact
/** The farthest things we built: distance from Earth now, and how long their radio signals take to arrive. */
async function farthest(now) {
  const all = await fetchAsset('data/solar/spacecraft.json', 'json'), jd = jdFromMs(now), E = earthPosition(jd), AU = 149597870.7;
  return all.map(c => { const p = craftAt(c, jd); if (!p) return null; const au = Math.hypot(p.x - E.x, p.y - E.y, p.z - E.z), s = au * 499.004784;
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60), km = au * AU;
    return { name: c.name, au, text: `${c.name}: ${km > 1e9 ? (km / 1e9).toFixed(1) + ' billion' : Math.round(km / 1e6) + ' million'} km away (${au.toFixed(au < 10 ? 2 : 0)} AU). ${SILENT[c.name] ? `Silent since ${SILENT[c.name]}; a signal from there would take ${h ? h + ' h ' : ''}${m} min.` : `Its radio signal takes ${h ? h + ' h ' : ''}${m} min to reach us.`}` }; })
    .filter(Boolean).sort((a, b) => b.au - a.au).slice(0, 4);
}
const bearing = (la1, lo1, la2, lo2) => { const r = Math.PI / 180, y = Math.sin((lo2 - lo1) * r) * Math.cos(la2 * r), x = Math.cos(la1 * r) * Math.sin(la2 * r) - Math.sin(la1 * r) * Math.cos(la2 * r) * Math.cos((lo2 - lo1) * r); return (Math.atan2(y, x) / r + 360) % 360; };

/** Where the ISS is right now, in words. */
async function issNow() {
  const s = D.sats.byId.get('25544'), sl = window.satellite; if (!s || !sl) return '';
  const rec = s.rec || (s.rec = sl.twoline2satrec(s.l1, s.l2)), d = new Date(), pv = sl.propagate(rec, d); if (!pv.position) return '';
  const g = sl.eciToGeodetic(pv.position, sl.gstime(d)), lat = sl.degreesLat(g.latitude), lon = sl.degreesLong(g.longitude);
  const k = await D.countryName(lon, lat).catch(() => null);
  return `Right now the ISS is over ${k || oceanAt(lat, lon)}, ${Math.round(g.height)} km up, doing 28,000 km/h (a lap of the Earth every 92 minutes).`;
}
/** The next launch anywhere, and any in the next week close enough to see from here (a plume shows ~1,000 km away at dusk or night). */
async function launchesNear(loc) {
  const list = await D.launches(); const now = Date.now(), out = [];
  const precise = l => ['SEC', 'MIN', 'HR', ''].includes(String(l.precision).toUpperCase()) && l.net > now;
  const next = list.find(precise);
  for (const l of list.filter(l => precise(l) && l.net < now + 7 * DAY)) {
    const km = haversine(loc.lat, loc.lon, l.lat, l.lon) / 1000; if (km > 1000) continue;
    const dark = sunAlt(loc.lat, loc.lon, l.net) < -4, dir = compass(bearing(loc.lat, loc.lon, l.lat, l.lon));
    out.push({ l, text: `${l.rocket} from ${l.place || l.pad}, ${time(l.net)}: ${Math.round(km)} km from you, toward the ${dir}. ${km < 150 ? 'Close enough to hear it.' : ''} ${dark ? 'After dark or at dusk, so watch for the plume rising and the bright exhaust.' : 'In daylight, so it\'s hard to see unless you are close.'}` });
  }
  if (next && !out.some(x => x.l === next)) out.push({ l: next, text: `Next launch anywhere: ${next.rocket} (${next.provider}), ${time(next.net)} from ${next.place || next.pad}.` });
  return out;
}

function card(html) { const c = $('#card'); state.selected = null; c.innerHTML = `<button class="x" aria-label="Close">×</button>${html}`; c.classList.add('show'); c.querySelector('.x').onclick = () => Tonight.close(); fold(c); return c; }
// sections fold: tap a heading to hide what's under it (remembered on this device)
const SHUT = new Set(store.get('tnShut', ['Farthest from home']));
function fold(c) {
  for (const h of c.querySelectorAll('h3')) {
    const name = h.firstChild ? h.firstChild.textContent.trim() : '', body = [];
    for (let n = h.nextElementSibling; n && n.tagName !== 'H3' && !n.classList.contains('acts') && !(n.tagName === 'P' && n.classList.contains('note')); n = n.nextElementSibling) body.push(n);
    if (!body.length) continue;
    const set = shut => { h.classList.toggle('shut', shut); h.setAttribute('aria-expanded', String(!shut)); for (const n of body) n.hidden = shut; };
    h.tabIndex = 0; h.setAttribute('role', 'button'); h.classList.add('fold'); set(SHUT.has(name));
    h.onclick = h.onkeydown = e => { if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return; e.preventDefault(); const shut = !h.classList.contains('shut'); set(shut); shut ? SHUT.add(name) : SHUT.delete(name); store.set('tnShut', [...SHUT]); };
  }
}

function intro(msg = '') {
  const c = card(`<div class="k" style="--c:#7dffa6">Your sky</div><h2>Tonight above you</h2>
    <p class="note">The space station, Starlink trains, bright planets, the Moon and the aurora chance where you are, in plain words, with reminders.</p>
    ${msg ? `<p class="note warn">${esc(msg)}</p>` : ''}
    <div class="acts"><button class="chipbtn" id="tnLoc" style="color:#7dffa6">Use my location</button><button class="chipbtn" id="tnGreen">Try Greenwich</button></div>
    <p class="note">Your location is used on this device only (saved rounded to about 1 km, so the next visit can tell you straight away). The cloud forecast is asked for a point rounded to about 10 km (Open-Meteo); nothing else leaves this device.</p>`);
  c.querySelector('#tnLoc').onclick = async () => {
    c.querySelector('#tnLoc').textContent = 'Finding you…';
    const p = await locate(); if (!p) return intro('Location was refused or unavailable. You can try Greenwich instead, or allow location for this site.');
    show(home.set(p.latitude, p.longitude));
  };
  c.querySelector('#tnGreen').onclick = () => show({ lat: 51.48, lon: 0, demo: true });
}

const passRow = (p, i) => `<div class="tn-row"><span>${esc(describePass(p.name, p, { time }))}${S.hours && cloudAt(S.hours, p.rise) != null ? ` <b class="${cloudAt(S.hours, p.rise) < 45 ? 'ok' : 'cl'}">· ${esc(skyWord(cloudAt(S.hours, p.rise)))}</b>` : ''}</span><span class="tn-b"><button class="chipbtn" data-rem="${i}" title="A notification 10 minutes before, while this page is open">Remind me</button><button class="chipbtn" data-cal="${i}" title="A calendar event with a reminder: works with the site closed">Calendar</button></span></div>`;

function render(initial = false) {
  if (!S.open || !S.loc) return;
  const cur = $('#card');   // closed, or replaced by another card (Esc, a click on the globe): stop updating it
  if (!initial && !(cur.classList.contains('show') && cur.querySelector('.tn-head'))) { S.open = false; S.run++; return; }
  const { lat, lon, demo } = S.loc, now = Date.now(), list = S.passes.filter(p => p.set > now).sort((a, b) => a.rise - b.rise);
  const planets = planetsTonight(lat, lon, now, { time }), up = planets.filter(p => p.up), moon = moonPhase(now);
  const first = list.find(p => p.visible), sky = sunAlt(lat, lon, now);
  const sm = sunMoon(lat, lon, now), cl = cloudText(lat, lon, now);
  const soon = (S.meet && S.meetAt > now - 3600e3 ? S.meet : (S.meetAt = now, S.meet = meetings(now, { days: 30 }))).filter(m => m.elong >= 15).slice(0, 5)
    .map(m => `${new Date(m.at).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}: ${m.ka === 'moon' ? `the Moon passes ${m.sep.toFixed(1)}° from ${m.b}` : `${m.a} and ${m.b} just ${m.sep.toFixed(1)}° apart`}${m.elong < 30 ? ' (low, in twilight)' : ''}. ${m.sep < 1 ? 'They\'ll fit in the same binocular view.' : 'A pretty pair to the eye.'}`);
  const showers = showersFor(lat, lon, now, { time }).filter(m => m.days > -2 || m.rate >= 3);   // drop the long faint tails
  const head = [first ? `Next to see: <b>${esc(first.short)} at ${esc(time(first.rise))}</b>, look ${esc(compass(first.azRise))}.` : S.computing ? 'Working out the passes…' : 'No bright satellite passes in a dark sky in the next 24 hours.',
    up.length ? `${esc(up.map(p => p.name).join(', '))} ${up.length > 1 ? 'are' : 'is'} up tonight.` : '',
    cl ? (/all night/.test(cl.text) && cl.clear.length ? '<b>Clear skies tonight.</b>' : cl.clear.length ? `<b>Clear from ${esc(time(cl.clear[0].from))} to ${esc(time(cl.clear[0].to))}.</b>` : `<b class="cl">${cl.mean >= 75 ? 'Cloudy tonight.' : 'Patchy cloud tonight.'}</b>`) : '',
    S.aurora && S.aurora.level >= 2 ? `<b class="ok">${esc(S.aurora.text)}</b>` : ''].filter(Boolean).join(' ');
  const watching = !!store.get('auroraWatch', null);
  S.summary = [`Tonight's sky${demo ? ' over Greenwich' : ''}:`, first ? `${first.short} at ${time(first.rise)}, look ${compass(first.azRise)}` : '', cl ? (cl.clear.length ? `clear ${time(cl.clear[0].from)} to ${time(cl.clear[0].to)}` : `cloudy (${cl.mean}%)`) : '',
    up.length ? `${up.map(p => p.name).join(', ')} up` : '', `Moon ${Math.round(moon.lit * 100)}% lit`, S.aurora && S.aurora.level >= 2 ? S.aurora.text : ''].filter(Boolean).join(' · ');
  const c = card(`<div class="k" style="--c:#7dffa6">${demo ? 'Greenwich, London (example)' : `Your sky · ${lat.toFixed(2)}, ${lon.toFixed(2)} · saved on this device`}</div><h2>Tonight above you</h2>
    <p class="tn-head">${head}</p>
    ${S.iss ? `<p class="tn-p" style="margin-top:6px">${esc(S.iss)}${S.crew ? ` ${esc(S.crew)} <a href="#" id="tnCrew">Who?</a>` : ''}</p>` : ''}
    <h3>Clouds tonight</h3><p class="tn-p">${cl ? esc(cl.text) + (cl.next ? ' ' + esc(cl.next) : '') : S.cloudErr ? esc(S.cloudErr) : S.hours ? 'No dark sky to forecast.' : 'Checking the cloud forecast…'} <small>Forecast: Open-Meteo.com (CC BY 4.0)</small></p>
    <h3>Satellites you can see${S.computing ? ' <small>· still searching…</small>' : ''}</h3>
    <div class="tn-list">${list.filter(p => p.visible).map(p => passRow(p, S.passes.indexOf(p))).join('') || '<p class="note">None in sunlight against a dark sky in the next 24 hours. Passes in daylight happen, but you can\'t see them.</p>'}</div>
    <h3>Planets</h3><div class="tn-list">${planets.map(p => `<div class="tn-row${p.up ? '' : ' dim'}"><span>${esc(p.text)}</span></div>`).join('')}</div>
    ${showers.length ? `<h3>Meteor showers</h3><div class="tn-list">${showers.map((m, i) => `<div class="tn-row"><span>${esc(m.text)}</span>${m.radiantAlt >= 10 && m.days > 0.75 ? `<span class="tn-b"><button class="chipbtn" data-met="${i}" title="A calendar event for the best time on the peak night">Calendar</button></span>` : ''}</div>`).join('')}</div>` : ''}
    ${S.launches.length ? `<h3>Rocket launches</h3><div class="tn-list">${S.launches.map((x, i) => `<div class="tn-row"><span>${esc(x.text)}</span><span class="tn-b"><button class="chipbtn" data-lch="${i}">Details</button></span></div>`).join('')}</div>` : ''}
    <h3>Sun</h3><p class="tn-p">${esc(sm.sunText)}</p>
    <h3>Moon</h3><p class="tn-p">${esc(moon.name)} · ${Math.round(moon.lit * 100)}% lit · ${esc(sm.moonText)}${sky > 0 ? ' · it is daytime here now' : ''}<br><small>${esc(sm.full)}</small></p>
    <h3>Aurora</h3><p class="tn-p">${S.aurora ? esc(S.aurora.text) + ` <small>(NOAA OVATION: ${S.aurora.overhead}% overhead)</small>` : 'Checking NOAA\'s aurora forecast…'}</p>
    <div class="acts"><button class="chipbtn" id="tnAur">${watching ? 'Stop aurora alerts' : 'Alert me if aurora gets likely'}</button></div>
    ${soon.length ? `<h3>Coming up in the sky</h3><div class="tn-list">${soon.map(t => `<div class="tn-row"><span>${esc(t)}</span></div>`).join('')}</div>` : ''}
    ${S.ecl ? `<h3>Next solar eclipse you can see</h3><div class="tn-list"><div class="tn-row"><span>${esc(new Date(S.ecl.at).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))}, ${esc(new Date(S.ecl.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}: ${S.ecl.kind === 'total' ? '<b class="ok">TOTAL</b> from here' : S.ecl.kind === 'annular' ? 'a ring of fire from here' : `the Moon covers ${Math.round(S.ecl.covered * 100)}% of the Sun from here`}${S.ecl.e.type === 'total' && S.ecl.kind !== 'total' ? ' (totality elsewhere)' : ''}. Never look at the Sun without eclipse glasses.</span>${D.watchEclipse ? '<span class="tn-b"><button class="chipbtn" id="tnEcl">Watch the shadow</button></span>' : ''}</div></div>` : S.ecl === false ? '<h3>Solar eclipses</h3><p class="tn-p">None visible from here in 2027–2030.</p>' : ''}
    ${S.far.length ? `<h3>Farthest from home</h3><div class="tn-list">${S.far.map(f => `<div class="tn-row"><span>${esc(f.text)}</span></div>`).join('')}</div>` : ''}
    <div class="acts">${D.lookUp ? '<button class="chipbtn" id="tnLook" style="color:#7dffa6">Look up</button>' : ''}<button class="chipbtn" id="tnShare">Share tonight</button>${demo ? '<button class="chipbtn" id="tnLoc">Use my location</button>' : '<button class="chipbtn" id="tnForget">Forget my location</button>'}</div>
    <p class="note">Times are yours (${esc(Intl.DateTimeFormat().resolvedOptions().timeZone || 'local')}). "Calendar" adds an event that reminds you 10 minutes before, even with this site closed. "Remind me" and aurora alerts work while this page is open in a tab.</p>`);
  bindPasses(c);
  if (c.querySelector('#tnCrew')) c.querySelector('#tnCrew').onclick = e => { e.preventDefault(); S.open = false; Crew.open({ back: () => Tonight.open() }); };
  if (c.querySelector('#tnEcl')) c.querySelector('#tnEcl').onclick = () => { S.open = false; D.watchEclipse(S.ecl.e); };
  c.querySelectorAll('[data-lch]').forEach(b => { b.onclick = () => { S.open = false; D.showLaunch(S.launches[+b.dataset.lch].l); }; });
  c.querySelectorAll('[data-met]').forEach(b => { b.onclick = () => {
    const m = showers[+b.dataset.met], night = showersFor(lat, lon, m.peakMs - 12 * HOUR, { time }).find(x => x.name === m.name), at = (night && night.bestMs) || m.peakMs;
    Alerts.calendar([{ uid: `oo-${m.name.replace(/\W+/g, '')}-${new Date(m.peakMs).getUTCFullYear()}@open-overwatch`, start: at - HOUR, end: at + HOUR, title: `${m.name} meteor shower: look up (radiant ${m.dir})`, details: `${m.text}\nFrom ${m.parent}, hitting the air at ${m.kms} km/s. Get away from lights, give your eyes 20 minutes, lie back.\nhttps://cwbhood.github.io/open-overwatch/globe.html#go=tonight`, alarmMin: 30 }], `${m.name.toLowerCase().replace(/\W+/g, '-')}.ics`);
  }; });
  c.querySelector('#tnAur').onclick = async () => {
    if (watching) { try { localStorage.removeItem('oo3d.auroraWatch'); } catch (e) { /* private mode */ } toast('Aurora alerts off'); return render(); }
    if (!(await Alerts.permission())) return toast('Notifications are blocked or not supported in this browser', 4000);
    store.set('auroraWatch', { lat, lon }); toast('Aurora alerts on: checked every 10 minutes while this page is open, once a night at most', 5000); render(); Tonight.watchAurora(); Tonight.checkAurora();
  };
  c.querySelector('#tnShare').onclick = async () => {
    const url = 'https://cwbhood.github.io/open-overwatch/globe.html#go=tonight', text = S.summary + '\nSee yours:';
    if (navigator.share) { try { await navigator.share({ title: "Tonight's sky", text, url }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    try { await navigator.clipboard.writeText(text + ' ' + url); toast('Copied: paste it into a message', 3000); } catch (e) { window.prompt('Copy this:', text + ' ' + url); }
  };
  if (c.querySelector('#tnLook')) c.querySelector('#tnLook').onclick = () => { Tonight.close(); D.lookUp(); };
  if (c.querySelector('#tnForget')) c.querySelector('#tnForget').onclick = () => { home.forget(); toast('Location forgotten'); intro(); };
  if (c.querySelector('#tnLoc')) c.querySelector('#tnLoc').onclick = async () => { const p = await locate(); if (p) show(home.set(p.latitude, p.longitude)); else toast('Location refused or unavailable', 4000); };
}

async function show(loc) {
  const run = ++S.run; S.open = true; S.loc = loc; S.passes = []; S.aurora = null; S.computing = true; render(true);
  const obs = observer(loc.lat, loc.lon), t0 = Date.now(), t1 = t0 + DAY;
  S.crew = '';
  Crew.load().then(() => { if (run === S.run) { S.crew = Crew.sentence(); render(); } }, () => {});
  S.ecl = null;
  (D.nextEclipse ? D.nextEclipse(loc.lat, loc.lon) : Promise.resolve(null)).then(x => { if (run === S.run) { S.ecl = x || false; render(); } }, e => console.warn('eclipse', e));
  S.iss = ''; S.launches = []; S.far = []; S.hours = null; S.cloudErr = '';
  forecast(loc.lat, loc.lon).then(h => { if (run === S.run) { S.hours = h; render(); } }, e => { console.warn('clouds', e); if (run === S.run) { S.cloudErr = 'The cloud forecast is unreachable right now.'; render(); } });
  farthest(Date.now()).then(x => { if (run === S.run) { S.far = x; render(); } }, e => console.warn('farthest', e));
  launchesNear(loc).then(x => { if (run === S.run) { S.launches = x; render(); } }, () => {});
  D.auroraGrid().then(g => { if (run === S.run) { S.aurora = auroraAt(g.coordinates, loc.lat, loc.lon); render(); } }, () => { if (run === S.run) { S.aurora = { level: 0, overhead: 0, text: 'NOAA\'s aurora forecast is unreachable right now.' }; render(); } });
  const ok = await satsReady(); if (run !== S.run) return;   // a newer show() (another place) took over while satellites loaded
  if (!ok) { S.computing = false; render(); return; }
  issNow().then(t => { if (run === S.run) { S.iss = t; render(); } }, () => {});
  const add = (s, name, short, ps) => { for (const p of ps) S.passes.push({ ...p, id: s.id, name, short }); };
  for (const [id, name, short] of MAIN) { const s = D.sats.byId.get(id); if (s) add(s, name, short, passesOf(s, obs, t0, t1)); }
  if (run !== S.run) return; render(); await breathe();
  for (const t of starlinkTrains(D.sats.list.filter(s => s.layer === 'starlink')).slice(0, 3)) {
    const s = D.sats.byId.get(t.sat.id) || t.sat; add(s, `Starlink train (launched ${t.launch}, ${t.count} satellites in a line)`, 'Starlink train', passesOf(s, obs, t0, t1)); await breathe(); if (run !== S.run) return;
  }
  if (run !== S.run) return; render();
  // the brightest other satellites, only when they climb high in a dark sky (a coarser search: there are ~150 of them)
  const bright = [];
  for (const s of D.sats.list.filter(x => x.layer === 'visual' && !MAIN.some(([id]) => id === x.id)).slice(0, 90)) {
    for (const p of passesOf(s, obs, t0, t1, 60e3)) if (p.visible && p.maxEl >= 45) bright.push([p, s]);
    await breathe(); if (run !== S.run) return;
  }
  bright.sort((a, b) => b[0].maxEl - a[0].maxEl);
  const seen = new Set(); for (const [p, s] of bright) { if (seen.has(s.id) || seen.size >= 4) continue; seen.add(s.id); add(s, `${friendly(s.name)} (bright satellite)`, friendly(s.name), [p]); }
  S.computing = false; render();
}

/** "When can I see it?" for one satellite: its passes over you in the next 3 days, visible ones marked, with reminders. */
async function forSat(s, loc) {
  const c = card(`<div class="k" style="--c:#7dffa6">Passes over you</div><h2>${esc(s.name)}</h2><p class="note">Working it out…</p>`);
  await new Promise(r => setTimeout(r, 30));
  const t0 = Date.now(), all = passesOf(s, observer(loc.lat, loc.lon), t0, t0 + 3 * DAY), short = friendly(s.name);
  S.passes = all.map(p => ({ ...p, id: s.id, name: friendly(s.name), short }));
  const vis = S.passes.filter(p => p.visible), rows = (vis.length ? vis : S.passes).slice(0, 8);
  c.innerHTML = `<button class="x" aria-label="Close">×</button><div class="k" style="--c:#7dffa6">${loc.demo ? 'From Greenwich (example)' : `From ${loc.lat.toFixed(2)}, ${loc.lon.toFixed(2)}`} · next 3 days</div><h2>${esc(s.name)}</h2>
    <p class="tn-head">${vis.length ? `${vis.length} pass${vis.length > 1 ? 'es' : ''} you can see with your eyes (in sunlight, against a dark sky).` : S.passes.length ? 'It passes over, but always in daylight or in Earth\'s shadow, so you can\'t see it. All passes:' : 'It never rises above 10° from here in the next 3 days.'}</p>
    <div class="tn-list">${rows.map(p => passRow(p, S.passes.indexOf(p))).join('')}</div>
    <p class="note">Satellites shine by reflected sunlight: the best passes are an hour or two after sunset or before sunrise. Fainter satellites may need binoculars.</p>`;
  c.querySelector('.x').onclick = () => Tonight.close();
  bindPasses(c);
}
function bindPasses(c) {
  c.querySelectorAll('[data-rem]').forEach(b => { b.onclick = () => { const p = S.passes[+b.dataset.rem], now = Date.now();
    if (p.rise - 60e3 <= now) { toast(p.set > now ? `${p.short} is up now: look ${compass(p.azRise)} to ${compass(p.azSet)}!` : `${p.short} has already passed`, 6000); return; }
    if (p.rise - 10 * 60e3 <= now) { Alerts.remind({ tag: `pass-${p.id}-${Math.round(p.rise / 60e3)}`, at: p.rise - 60e3, title: `${p.short} in 1 minute`, body: describePass(p.short, p, { time }) }); return; }   // closer than 10 minutes: a minute's warning
    Alerts.remind({ tag: `pass-${p.id}-${Math.round(p.rise / 60e3)}`, at: p.rise - 10 * 60e3, title: `${p.short} in 10 minutes`, body: describePass(p.short, p, { time }) }); }; });
  c.querySelectorAll('[data-cal]').forEach(b => { b.onclick = () => { const p = S.passes[+b.dataset.cal]; Alerts.calendar([{ uid: `oo-${p.id}-${Math.round(p.rise / 60e3)}@open-overwatch`, start: p.rise, end: p.set, title: `${p.short} passes over: look ${compass(p.azRise)}`, details: describePass(p.name, p, { time }) + '\nhttps://cwbhood.github.io/open-overwatch/globe.html#go=tonight', alarmMin: 10 }], `${p.short.toLowerCase().replace(/\W+/g, '-')}-pass.ics`); }; });
}

/**
 * What this card needs from the page it lives on (the 3D globe, or the light tonight.html):
 *   sats: { list, byId }    satellites with { id, name, layer, l1, l2 }, filled as they load
 *   auroraGrid() -> Promise<OVATION json>      countryName(lon, lat) -> Promise<name | null>
 *   launches() -> Promise<[launch]>            showLaunch(launch)
 *   nextEclipse(lat, lon) -> Promise | null     watchEclipse(e)      lookUp()   (optional: their buttons hide without them)
 */
let D = null;

export const Tonight = {
  use(deps) { D = deps; return this; },
  open() { S.open = true; const h = home.get(); if (h) show(h); else intro(); },
  /** Passes of one satellite over the saved location (asks for it first if there isn't one). */
  async forSat(s) {
    S.open = false; S.run++;
    const c = card(`<div class="k" style="--c:#7dffa6">Passes over you</div><h2>${esc(s.name)}</h2><p class="note" data-wait="see">Finding where you are…</p>`);
    const mine = () => !!c.querySelector('[data-wait="see"]');   // the user opened something else meanwhile: leave it be
    let h = home.get();
    if (!h) { const p = await locate(); if (p) h = home.set(p.latitude, p.longitude); else { h = { lat: 51.48, lon: 0, demo: true }; toast('Location unavailable: showing passes over Greenwich', 4000); } }
    if (!mine()) return;
    c.querySelector('[data-wait="see"]').textContent = 'Working it out…';
    if (!(await satsReady())) { if (mine()) c.querySelector('[data-wait="see"]').textContent = "The satellite orbits aren't loaded yet: try again in a moment."; return; }
    if (mine()) forSat(s, h);
  },
  close() { S.open = false; S.run++; $('#card').classList.remove('show'); },
  /** After boot: if this device has a saved location, say the next thing worth seeing in one line. */
  async peek() {
    Alerts.init(); this.watchAurora();
    const h = home.get(); if (!h || !(await satsReady(60e3))) return;
    const iss = D.sats.byId.get('25544'); if (!iss) return;
    const obs = observer(h.lat, h.lon), now = Date.now();
    // "look up now": a nudge a minute before each visible station pass in the next 12 hours, while this page is open
    for (const [id, short] of [['25544', 'The ISS'], ['48274', 'Tiangong']]) {
      const sat = D.sats.byId.get(id); if (!sat) continue;
      for (const q of passesOf(sat, obs, now, now + 12 * HOUR).filter(x => x.visible && x.maxEl >= 20)) {
        const say = () => { const t = `${short} is rising in the ${compass(q.azRise)} now: up to ${Math.round(q.maxEl)}° high, bright, for about ${Math.max(1, Math.round((q.set - q.rise) / 60e3))} min. Look up!`;
          if ('Notification' in window && Notification.permission === 'granted') Alerts.now('Look up now', t, 'now-' + id); else toast(t, 15000); };
        setTimeout(say, Math.max(0, q.rise - 60e3 - now));
      }
    }
    if (S.open) return;
    const p = passesOf(iss, obs, now, now + DAY).find(x => x.visible);
    if (p) toast(`Tonight over you: the ISS at ${time(p.rise)}, look ${compass(p.azRise)} · tap "Tonight" for more`, 8000);
  },
  /** Aurora alerts: while the page is open, every 10 minutes, at most once in 6 hours, only when it is dark. */
  watchAurora() {
    if (this._aw) return;
    const check = async () => {
      const w = store.get('auroraWatch', null); if (!w) return;
      const now = Date.now(); if (sunAlt(w.lat, w.lon, now) > -12 || now - store.get('auroraSaid', 0) < 6 * HOUR) return;
      const a = auroraAt((await D.auroraGrid()).coordinates, w.lat, w.lon);
      if (a.level >= 2) { store.set('auroraSaid', now); Alerts.now('Aurora likely now', a.text, 'aurora'); }
    };
    this.checkAurora = () => check().catch(e => console.warn('aurora watch', e));
    this._aw = setInterval(this.checkAurora, 10 * 60e3); this.checkAurora();
  },
};
