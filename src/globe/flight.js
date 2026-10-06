// Find a flight: type what's on the ticket ("BA 123"), a callsign, a registration or an ICAO hex, and follow that plane
// on the globe. The download version asks adsb.lol for a fresh fix (every 15 s while you follow it); the ADS-B feeds send
// no CORS headers, so the website can only search what it already has and otherwise opens adsb.lol's own live map.
// A followed flight goes into the share link (&f=), so you can send family a link that finds their plane.
import { $, esc, toast, getJSON, RELAY } from './env.js';
import { state, hooks } from './state.js';
import { L, syncDock } from './layers.js';
import { Air, AirModels, fromAdsb } from './aircraft.js';
import { Follow } from './follow.js';
import { Time } from './time.js';
import { select } from './ui.js';
import { parseFlightQuery, matchesFlight, normCallsign } from '../core/flight.js';

const API = 'https://api.adsb.lol/v2';

function liveMap(q) {   // adsb.lol's tar1090 map, filtered to this plane
  const base = 'https://globe.adsb.lol/?';
  if (q.hex) return base + 'icao=' + encodeURIComponent(q.hex);
  if (q.reg) return base + 'reg=' + encodeURIComponent(q.reg);
  return base + 'filterCallSign=' + encodeURIComponent('^(' + q.callsigns.join('|') + ')$');
}

async function lookup(q) {   // a fresh fix from adsb.lol (download version only)
  const urls = [q.hex && `${API}/hex/${q.hex}`, q.reg && `${API}/reg/${encodeURIComponent(q.reg)}`, ...q.callsigns.map(c => `${API}/callsign/${c}`)].filter(Boolean);
  for (const u of urls) {
    const d = await getJSON(u, { relay: true, timeout: 15000 }).catch(() => null), now = Date.now();
    const a = (d && d.ac || []).find(x => x.lat != null && x.lon != null && matchesFlight({ hex: x.hex, reg: x.r, flight: x.flight }, q));
    if (a) { Air.upsert(fromAdsb(a, now)); return Air.map.get(a.hex); }
  }
  return null;
}

export const Flight = {
  query: null, rec: null, timer: 0,
  /** What the share link carries: the callsign we found (or what was typed). */
  get shareId() {
    const o = Follow.obj && Follow.obj.kind === 'air' ? Follow.obj : state.selected && state.selected.kind === 'air' ? state.selected : null;
    return o ? normCallsign(o.flight) || o.hex : null;
  },
  /** msg and extra are HTML: callers escape anything typed. */
  open(msg = '', extra = '') {
    const c = $('#card'); hooks.clearSelection?.();
    c.innerHTML = `<button class="x" aria-label="Close">×</button><div class="k" style="--c:#5fd3ff">Live ADS-B</div><h2>Find a flight</h2>
      <form id="flForm" class="fl-form" autocomplete="off"><input id="flQ" maxlength="12" placeholder="BA 123 · EZY8123 · G-EUPT" aria-label="Flight number, callsign, registration or hex" value="${esc(this.query ? this.query.label : '')}"><button class="chipbtn" style="color:#5fd3ff">Find</button></form>
      <p class="note" id="flMsg">${msg}</p>${extra}
      <p class="note">Type the flight number from the ticket, the callsign, the registration or the ICAO hex. ${RELAY ? 'Positions come from adsb.lol\'s volunteer receivers.' : 'On the website this searches the planes already on the globe; the download version asks the live feed for any flight.'}</p>`;
    c.classList.add('show'); c.querySelector('.x').onclick = () => { c.classList.remove('show'); };
    const input = c.querySelector('#flQ'); setTimeout(() => input.focus(), 50);
    c.querySelector('#flForm').onsubmit = e => { e.preventDefault(); this.find(input.value); };
  },
  async find(text) {
    const q = parseFlightQuery(text);
    if (!q) return this.open('That doesn\'t look like a flight number, callsign, registration or hex code.');
    this.query = q; this.stop(); const run = this.run = (this.run || 0) + 1;
    if ($('#flMsg')) $('#flMsg').textContent = 'Looking…';
    let r = [...Air.map.values()].find(x => matchesFlight(x, q));
    if (RELAY) r = (await lookup(q).catch(() => null)) || r;
    if (run !== this.run) return;   // a newer search took over
    if (!($('#card').classList.contains('show') && $('#flForm'))) return;   // the user opened something else while adsb.lol answered: leave it be
    if (!r) {
      const map = `<a class="chipbtn" href="${esc(liveMap(q))}" target="_blank" rel="noopener" style="color:#5fd3ff">Open on adsb.lol's live map ↗</a>`;
      const why = RELAY ? `${esc(q.label)} isn't in the air right now, or no volunteer receiver can hear it (oceans and remote areas have gaps).`
        : `${esc(q.label)} isn't among the planes on this globe. Live flight feeds don't let websites read them, so the website can't ask for one plane; the <a href="https://github.com/cwbhood/open-overwatch/releases/latest/download/open-overwatch.zip">download version</a> can.`;
      return this.open(why, `<div class="acts">${map}</div>`);
    }
    Time.goLive();   // only now that there is a plane to follow (aircraft are live-only)
    const lay = L[r.mil ? 'mil' : 'air']; if (!lay.on) { lay.on = true; syncDock(); hooks.applyVisibility(); }
    this.rec = r; select(r); AirModels.follow(r);
    toast(`Found ${r.flight || r.hex}${r.reg ? ' · ' + r.reg : ''} · following it`, 4000);
    if (RELAY) { const id = this.timer = setInterval(() => {   // keep it fresh while you are following or looking at it
      if (Follow.obj !== r && state.selected !== r) { clearInterval(id); if (this.timer === id) this.timer = 0; return; }
      lookup({ hex: r.hex, reg: '', callsigns: [] }).then(x => { if (x && state.selected === x) hooks.reselect(x); }).catch(() => {});
    }, 15e3); }
  },
  stop() { clearInterval(this.timer); this.timer = 0; },
};
