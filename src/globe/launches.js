// Rocket launches: the next ~40 from The Space Devs' Launch Library 2 (copied by the site build into data/launches.json every
// 6 hours; without that copy the page asks the API once). Each pad with a launch coming gets a marker with a live countdown;
// the band's "Launches" opens the list, and a launch card has the countdown, how sure the time is, the mission, webcasts, a
// calendar reminder and a flight to the pad.
import { C, $, esc, toast } from './env.js';
import { viewer, scene, camera } from './viewer.js';
import { L, setCount } from './layers.js';
import { state, hooks } from './state.js';
import { release } from './follow.js';
import { Alerts } from './alerts.js';
import { fetchAsset } from '../core/assets.js';
import { fromLL2, countdown, when, upcoming } from '../core/launches.js';

const API = 'https://ll.thespacedevs.com/2.3.0/launches/upcoming/?limit=30&mode=normal&hide_recent_previous=true';
const ORANGE = C.Color.fromCssColorString('#ff9f5c');
const pts = scene.primitives.add(new C.PointPrimitiveCollection()), labels = scene.primitives.add(new C.LabelCollection());
const STATUS = { Go: ['Go for launch', '#7dffa6'], TBC: ['To be confirmed', '#ffd45c'], TBD: ['Date not fixed', '#8b9bab'], Hold: ['On hold', '#ff6b6b'], 'In Flight': ['In flight', '#5fd3ff'], Success: ['Success', '#7dffa6'], Failure: ['Failure', '#ff6b6b'] };
const local = ms => new Date(ms).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const precise = l => ['SEC', 'MIN', 'HR', ''].includes(String(l.precision).toUpperCase()) && Number.isFinite(l.net);

export const Launches = {
  list: [], loading: null, error: '', tick: 0, at: 0, failedAt: 0, stale: false,
  load() {
    if (!this.loading) this.loading = (async () => {
      let d = await fetchAsset('data/launches.json', 'json').catch(() => null), src = 'site copy';
      const stale = d && d.results && (!d.t || Date.now() - d.t > 36 * 3600e3);   // the build runs every 6 h: an old copy means the build has stopped
      if (!d || !d.results || stale) {
        try { const r = await fetch(API); if (!r.ok) throw new Error('HTTP ' + r.status); d = await r.json(); src = 'live'; }
        catch (e) { if (!stale) throw e; this.stale = true; }   // a stale copy beats nothing
      }
      this.list = upcoming((d.results || []).map(fromLL2).filter(Boolean).map(l => ({ ...l, kind: 'launch' })), Date.now());
      this.at = d.t || Date.now(); this.src = src; this.error = ''; this.failedAt = 0;
      viewer.creditDisplay.addStaticCredit(new C.Credit('Launch data: The Space Devs, Launch Library 2'));
      this.draw(); setCount('launches', this.list.length);
    })().catch(e => { console.warn('launches', e); this.error = "The launch schedule isn't reachable right now."; this.loading = null; this.failedAt = Date.now(); });
    return this.loading;
  },
  /** One marker per pad, for its next launch. */
  draw() {
    pts.removeAll(); labels.removeAll(); const seen = new Set();
    for (const l of this.list) {
      const key = l.lat.toFixed(3) + ',' + l.lon.toFixed(3); if (seen.has(key)) continue; seen.add(key);
      const pos = C.Cartesian3.fromDegrees(l.lon, l.lat, 200);
      l.pt = pts.add({ position: pos, pixelSize: 9, color: ORANGE, outlineColor: C.Color.BLACK.withAlpha(0.6), outlineWidth: 2, id: l });
      l.label = labels.add({ position: pos, text: '', font: '600 12px system-ui', fillColor: ORANGE, showBackground: true, backgroundColor: C.Color.fromCssColorString('#05080cbb'),
        pixelOffset: new C.Cartesian2(10, -10), horizontalOrigin: C.HorizontalOrigin.LEFT, distanceDisplayCondition: new C.DistanceDisplayCondition(0, 9.0e6), id: l });
    }
    this.relabel(); this.apply();
  },
  relabel() { const now = Date.now(); for (const l of this.list) if (l.label) l.label.text = `🚀 ${l.rocket}${precise(l) ? ' · ' + countdown(l.net, now).replace(/:\d\d$/, '') : ''}`; },
  apply() {
    pts.show = labels.show = L.launches.on && !state.lookup;   // look-up mode hides things on the ground
    if (L.launches.on && !this.loading && Date.now() - this.failedAt > 5 * 60e3) this.load();   // after a failure, try again in 5 minutes, not on every redraw
    clearInterval(this.labelTimer); if (L.launches.on) this.labelTimer = setInterval(() => this.relabel(), 30e3);
    scene.requestRender();
  },
  /** The list; with an id (from a share link or tonight.html), straight to that launch's card. */
  async openList(id = '') {
    const card = $('#card'); hooks.clearSelection?.(); clearInterval(this.tick);
    card.innerHTML = '<button class="x" aria-label="Close">×</button><div class="k" style="--c:#ff9f5c">Launch Library 2</div><h2>Launches</h2><p class="note" data-wait="lc">Loading…</p>'; card.classList.add('show');
    card.querySelector('.x').onclick = () => this.close(); await this.load();
    if (!card.querySelector('[data-wait="lc"]') || !card.classList.contains('show')) return;   // another card opened, or Esc, while the schedule loaded
    if (id) { const l = this.list.find(x => x.id === id); if (l) return this.show(l); }
    const rows = upcoming(this.list, Date.now());
    const row = (l, i) => { const [st, col] = STATUS[l.status] || [l.statusName || l.status, '#8b9bab']; return `<button class="cj lc" data-i="${i}"><b style="color:#ff9f5c" data-cd="${i}">${precise(l) ? esc(countdown(l.net, Date.now()).replace(/^T-(\d+) d .*/, 'T-$1 d')) : '—'}</b><span>${esc(l.mission)}</span><small>${esc(l.rocket)} · ${esc(l.provider)} · ${esc(l.place || l.pad)}<br><i style="color:${col};font-style:normal">${esc(st)}</i> · ${esc(precise(l) ? local(l.net) : when(l))}</small></button>`; };
    card.innerHTML = `<button class="x" aria-label="Close">×</button><div class="k" style="--c:#ff9f5c">${this.error ? 'Launch Library 2' : `Next ${rows.length} launches · ${this.src === 'live' ? 'live' : this.stale ? 'an older copy: the live schedule was unreachable' : 'updated every 6 hours'}`}</div><h2>Launches</h2>
      ${this.error ? `<p class="note">${esc(this.error)}</p>` : `<p class="note">Every orbital launch on the books, from every country. Orange markers on the globe are the pads. Times are yours.</p><div class="cjl">${rows.map(row).join('') || '<p class="note">None listed.</p>'}</div>`}`;
    card.querySelector('.x').onclick = () => this.close();
    card.querySelectorAll('.lc').forEach(b => { b.onclick = () => this.show(rows[+b.dataset.i]); });
    this.tick = setInterval(() => { if (!card.classList.contains('show') || !card.querySelector('.lc')) return clearInterval(this.tick); card.querySelectorAll('[data-cd]').forEach(el => { const l = rows[+el.dataset.cd]; if (precise(l)) el.textContent = countdown(l.net, Date.now()).replace(/^T-(\d+) d .*/, 'T-$1 d'); }); }, 1000);
  },
  show(l) {
    const card = $('#card'); hooks.clearSelection?.(); state.selected = l; clearInterval(this.tick);
    const [st, col] = STATUS[l.status] || [l.statusName || l.status || 'Scheduled', '#8b9bab'], row = (k, v) => v ? `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>` : '';
    const vids = l.webcasts.map(v => `<a class="chipbtn" href="${esc(v.url)}" target="_blank" rel="noopener" style="color:#ff6b6b" title="${esc(v.title)}">▶ ${l.live ? 'Live now' : 'Webcast'}</a>`).join('');
    card.innerHTML = `<button class="x" aria-label="Close">×</button><div class="k" style="--c:#ff9f5c">Rocket launch · <span style="color:${col}">${esc(st)}</span></div><h2>${esc(l.mission)}</h2>
      <p class="lc-cd" id="lcCd">${precise(l) ? esc(countdown(l.net, Date.now())) : esc(when(l))}</p>
      <dl>${row('When', precise(l) ? local(l.net) + (l.windowEnd > l.windowStart ? ` (window ${Math.round((l.windowEnd - l.windowStart) / 60e3)} min)` : '') : when(l))}${row('Rocket', l.rocket)}${row('Launched by', l.provider)}${row('Orbit', l.orbit)}${row('Mission', l.type)}${row('Pad', [l.pad, l.place].filter(Boolean).join(', '))}${l.prob != null ? row('Weather go', l.prob + '%') : ''}</dl>
      ${l.desc ? `<p class="note" style="margin-top:8px">${esc(l.desc)}</p>` : ''}
      <div class="acts" style="flex-wrap:wrap"><button class="chipbtn" id="lcFly" style="color:#ff9f5c">Fly to the pad</button>${precise(l) && l.net > Date.now() + 10 * 60e3 ? '<button class="chipbtn" id="lcRem">Remind me</button><button class="chipbtn" id="lcCal">Calendar</button>' : ''}${vids}<button class="chipbtn" id="lcAll">All launches</button></div>
      <div class="note" style="margin-top:6px">Launch Library 2 by The Space Devs. Dates slip often: check again on the day.</div>`;
    card.classList.add('show'); card.querySelector('.x').onclick = () => this.close();
    $('#lcFly').onclick = () => { release(); camera.flyTo({ destination: C.Cartesian3.fromDegrees(l.lon, l.lat - 0.22, 22000), orientation: { heading: 0, pitch: C.Math.toRadians(-38), roll: 0 }, duration: 3 }); };
    $('#lcAll').onclick = () => this.openList();
    const title = `${l.rocket} launch: ${l.mission}`, details = `${l.provider} · ${[l.pad, l.place].filter(Boolean).join(', ')}${l.webcasts[0] ? '\nWebcast: ' + l.webcasts[0].url : ''}\nhttps://cwbhood.github.io/open-overwatch/globe.html#go=launches`;
    if ($('#lcRem')) $('#lcRem').onclick = () => Alerts.remind({ tag: 'launch-' + l.id, at: l.net - 10 * 60e3, title: `${l.rocket} launches in 10 minutes`, body: `${l.mission} from ${l.place || l.pad}` });
    if ($('#lcCal')) $('#lcCal').onclick = () => Alerts.calendar([{ uid: `oo-launch-${l.id}@open-overwatch`, start: l.net, end: l.net + 30 * 60e3, title, details, alarmMin: 15 }], 'launch.ics');
    this.tick = setInterval(() => { const el = $('#lcCd'); if (!el || state.selected !== l) return clearInterval(this.tick); if (precise(l)) el.textContent = countdown(l.net, Date.now()); }, 1000);
  },
  close() { clearInterval(this.tick); state.selected = null; $('#card').classList.remove('show'); },
};
