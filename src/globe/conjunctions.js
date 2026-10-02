// Close approaches: the closest upcoming conjunctions from CelesTrak SOCRATES (data/socrates.json, made by the site
// build), listed in the details card. Picking one sets the clock to 45 s before the time of closest approach (TCA), puts
// both objects on screen with their orbits, follows the first and counts down while our own SGP4 (same public element
// sets) shows the range closing. Objects that aren't in the loaded groups can't be shown; the list says so.
import { C, $, esc, fmt, toast } from './env.js';
import { viewer, orbitLines } from './viewer.js';
import { L } from './layers.js';
import { state } from './state.js';
import { Follow } from './follow.js';
import { Sats, SatModels } from './satellites.js';
import { Time } from './time.js';
import { fetchAsset } from '../core/assets.js';
import { jdFromMs } from '../core/time.js';

const LEAD_MS = 45e3;
const ago = ms => { const s = Math.round(Math.abs(ms) / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : m ? `${m} min ${s % 60} s` : `${s} s`; };
const km = x => x < 1 ? Math.round(x * 1000) + ' m' : x.toFixed(x < 10 ? 2 : 0) + ' km';

export const Conj = {
  data: null, error: null, active: null, marks: [], hud: 0,
  async load() {
    if (this.data || this.error) return;
    try { this.data = await fetchAsset('data/socrates.json', 'json'); }
    catch (e) { this.error = 'The close-approach list is built with the website every 6 hours and isn\'t available here.'; }
  },
  async openList() {
    const card = $('#card'); state.selected = null;
    card.innerHTML = '<button class="x" aria-label="Close">×</button><div class="k" style="--c:#ff6b6b">Close approaches · next 7 days</div><h2>Near misses</h2><p class="note">Loading…</p>';
    card.classList.add('show'); card.querySelector('.x').onclick = () => this.close();
    await this.load();
    const now = Date.now(), rows = (this.data?.rows || []).filter(r => r.tca > now).slice(0, 60);
    const have = r => Sats.byId.has(r.a.id) || Sats.byId.has(r.b.id);
    const list = rows.map((r, i) => `<button class="cj${have(r) ? '' : ' dim'}" data-i="${i}"><b>${km(r.rangeKm)}</b><span>${esc(r.a.name)} × ${esc(r.b.name)}</span><small>in ${ago(r.tca - now)} · ${r.speedKmS.toFixed(1)} km/s</small></button>`).join('');
    card.innerHTML = `<button class="x" aria-label="Close">×</button><div class="k" style="--c:#ff6b6b">Close approaches · next 7 days</div><h2>Near misses</h2>
      ${this.error ? `<p class="note">${esc(this.error)}</p>` : `<p class="note">Predicted by CelesTrak SOCRATES from public orbit data, updated ${esc((this.data.updated || '').slice(0, 16).replace('T', ' '))} UTC. Pick one to watch it happen.</p><div class="cjl">${list || '<p class="note">None listed.</p>'}</div>`}`;
    card.querySelector('.x').onclick = () => this.close();
    card.querySelectorAll('.cj').forEach(b => { b.onclick = () => this.watch(rows[+b.dataset.i]); });
  },
  watch(r) {
    const a = Sats.byId.get(r.a.id), b = Sats.byId.get(r.b.id);
    if (!a && !b) { toast('Neither object is in the loaded satellite groups'); return; }
    this.stop(false);
    for (const s of [a, b]) if (s && !L[s.layer].on) { L[s.layer].on = true; }
    this.active = { r, a, b };
    Time.setJd(jdFromMs(r.tca - LEAD_MS), 1);
    // both objects as bright markers at their exact SGP4 positions (debris has no model), plus their orbits
    orbitLines.removeAll();
    for (const [s, col] of [[a, '#7dffa6'], [b, '#ff6b6b']]) {
      if (!s) continue;
      this.marks.push(viewer.entities.add({ position: new C.CallbackProperty(t => { const st = SatModels.state(s, t); return st.ok ? st.pos : undefined; }, false),
        point: { pixelSize: 9, color: C.Color.fromCssColorString(col), outlineColor: C.Color.BLACK, outlineWidth: 1.5, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: { text: s.name, font: '600 13px system-ui', fillColor: C.Color.fromCssColorString(col), pixelOffset: new C.Cartesian2(12, -10), disableDepthTestDistance: Number.POSITIVE_INFINITY,
          showBackground: true, backgroundColor: C.Color.fromCssColorString('#05080cc0') } }));
      this.orbit(s, col);
    }
    const lead = a || b;
    Follow.start(lead, t => { const st = SatModels.state(lead, t); return st.ok ? st.pos : null; }, 25000, this.marks[0], 0);
    clearInterval(this.hud); this.hud = setInterval(() => this.updateHud(), 100); this.updateHud(true);
  },
  orbit(s, col) {
    const rec = s.rec || (s.rec = satellite.twoline2satrec(s.l1, s.l2)), t0 = Time.nowMs(), g = satellite.gstime(new Date(t0)), per = 2 * Math.PI / rec.no, pts = [];
    for (let k = 0; k <= 180; k++) {
      const pv = satellite.propagate(rec, new Date(t0 + k / 180 * per * 60000)); if (!pv.position) continue;
      const f = satellite.eciToEcf(pv.position, g); pts.push(new C.Cartesian3(f.x * 1000, f.y * 1000, f.z * 1000));
    }
    orbitLines.add({ positions: pts, width: 1.4, material: C.Material.fromType('Color', { color: C.Color.fromCssColorString(col).withAlpha(0.6) }) });
  },
  updateHud(first = false) {
    const x = this.active; if (!x) return;
    const t = viewer.clock.currentTime, sa = x.a && SatModels.state(x.a, t), sb = x.b && SatModels.state(x.b, t);
    const range = sa?.ok && sb?.ok ? C.Cartesian3.distance(sa.pos, sb.pos) / 1000 : null, dt = x.r.tca - Time.nowMs();
    const html = `<button class="x" aria-label="Close">×</button><div class="k" style="--c:#ff6b6b">Close approach · ${dt > 0 ? 'in ' + ago(dt) : ago(dt) + ' ago'}</div>
      <h2>${km(x.r.rangeKm)}</h2><dl>
      <dt>Objects</dt><dd><span style="color:#7dffa6">${esc(x.r.a.name)}</span><br><span style="color:#ff6b6b">${esc(x.r.b.name)}</span></dd>
      <dt>Apart now</dt><dd>${range == null ? '— (not loaded)' : km(range)}</dd>
      <dt>Closest at</dt><dd>${new Date(x.r.tca).toISOString().slice(11, 19)} UTC</dd>
      <dt>Relative speed</dt><dd>${x.r.speedKmS.toFixed(2)} km/s</dd>
      <dt>Max probability</dt><dd>${x.r.maxProb != null ? x.r.maxProb.toExponential(1) : '—'}</dd></dl>
      <p class="note">Range "now" is our own SGP4 from the same public element sets; SOCRATES predicted the minimum.</p>
      <div class="acts"><button class="chipbtn" id="cjBack">All close approaches</button><button class="chipbtn" id="cjNow">Back to live</button></div>`;
    const card = $('#card'); card.innerHTML = html; if (first) card.classList.add('show');
    card.querySelector('.x').onclick = () => this.close();
    $('#cjBack').onclick = () => { this.stop(true); this.openList(); };
    $('#cjNow').onclick = () => this.close();
  },
  stop(live = true) {
    clearInterval(this.hud); this.hud = 0;
    for (const e of this.marks) viewer.entities.remove(e); this.marks = [];
    if (this.active) { Follow.stop(); orbitLines.removeAll(); }
    this.active = null;
    if (live) Time.goLive();
  },
  close() { this.stop(true); $('#card').classList.remove('show'); },
};
