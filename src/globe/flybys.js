// Asteroid and comet flybys: the next 60 days of close approaches inside ~20 lunar distances (NASA/JPL CNEOS, copied by the
// site build into data/flybys.json). A list card like Near misses; pick one for a countdown, how close, how fast, how big, and
// "Show the scale", which flies out and draws the Moon's orbit and the object's closest distance as rings around the Earth.
import { C, $, esc, fmt, toast } from './env.js';
import { scene, camera } from './viewer.js';
import { state } from './state.js';
import { fetchAsset } from '../core/assets.js';

const LD_KM = 384400, AU_KM = 149597870.7;
const rings = scene.primitives.add(new C.PolylineCollection());
const ago = ms => { const s = Math.round(ms / 1000); return s < 0 ? 'passed' : s < 3600 ? Math.round(s / 60) + ' min' : s < 172800 ? Math.round(s / 3600) + ' h' : Math.round(s / 86400) + ' days'; };
const sizeOf = r => r.km != null ? r.km : r.h != null ? 3553 * Math.pow(10, -r.h / 5) : null;   // km; from the brightness H with a typical albedo of 0.14
const compare = km => km == null ? '' : km < 0.004 ? 'about a car' : km < 0.012 ? 'about a bus' : km < 0.03 ? 'about a house' : km < 0.1 ? 'about a football pitch' : km < 0.3 ? 'about a skyscraper' : km < 1 ? 'bigger than most skyscrapers' : 'a mountain';
const nice = km => km == null ? 'unknown' : km < 1 ? `${fmt(km * 1000)} m` : `${km.toFixed(1)} km`;

export const Flybys = {
  data: null, error: '',
  async load() {
    if (this.data || this.error) return;
    try { this.data = await fetchAsset('data/flybys.json', 'json'); }
    catch (e) { this.error = "The flyby list is built with the website every 6 hours and isn't available here."; }
  },
  async openList() {
    const card = $('#card'); state.selected = null; this.clearRings();
    card.innerHTML = '<button class="x" aria-label="Close">×</button><div class="k" style="--c:#ffb44d">NASA close-approach data</div><h2>Flybys</h2><p class="note">Loading…</p>'; card.classList.add('show');
    card.querySelector('.x').onclick = () => this.close(); await this.load();
    const now = Date.now(), rows = (this.data?.rows || []).filter(r => r.tca > now - 3600e3).sort((a, b) => a.tca - b.tca);
    const list = rows.map((r, i) => `<button class="cj" data-i="${i}"><b style="color:#ffb44d">${(r.au * AU_KM / LD_KM).toFixed(1)} LD</b><span>${esc(r.name)}</span><small>${new Date(r.tca).toISOString().slice(5, 16).replace('T', ' ')} UTC · in ${ago(r.tca - now)} · ${nice(sizeOf(r))}</small></button>`).join('');
    card.innerHTML = `<button class="x" aria-label="Close">×</button><div class="k" style="--c:#ffb44d">Next 60 days · inside 20 lunar distances</div><h2>Flybys</h2>
      ${this.error ? `<p class="note">${esc(this.error)}</p>` : `<p class="note">Asteroids and comets passing Earth. 1 LD = the Moon's distance (384,400 km). Sizes are estimates from brightness. Pick one.</p><div class="cjl">${list || '<p class="note">None listed.</p>'}</div>`}`;
    card.querySelector('.x').onclick = () => this.close();
    card.querySelectorAll('.cj').forEach(b => { b.onclick = () => this.show(rows[+b.dataset.i]); });
  },
  show(r) {
    const card = $('#card'), d = r.au * AU_KM, size = sizeOf(r);
    const upd = () => { const el = $('#fbIn'); if (el) el.textContent = r.tca > Date.now() ? 'closest approach in ' + ago(r.tca - Date.now()) : 'passed ' + ago(Date.now() - r.tca) + ' ago'; };
    const row = (k, v) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`, pct = Math.min(100, d / (LD_KM * 20) * 100);
    card.innerHTML = `<button class="x" aria-label="Close">×</button><div class="k" style="--c:#ffb44d">Flyby</div><h2>${esc(r.name)}</h2><p id="fbIn" class="note" style="margin:0 0 8px"></p>
      <dl>${row('Closest approach', new Date(r.tca).toISOString().slice(0, 16).replace('T', ' ') + ' UTC')}${row('Distance', `${fmt(d)} km · ${(d / LD_KM).toFixed(1)}× the Moon's`)}${row('Speed', r.kms.toFixed(1) + ' km/s · ' + fmt(r.kms * 3600) + ' km/h')}
      ${row('Size (estimate)', nice(size) + (size ? ' · ' + compare(size) : ''))}${r.h != null ? row('Brightness H', r.h.toFixed(1)) : ''}</dl>
      <div class="fb-scale" title="from Earth (left) to 20 lunar distances (right)"><i style="left:5%"></i><b style="left:${pct.toFixed(1)}%"></b><span>Earth</span><span style="left:5%">Moon</span><span style="left:100%">20 LD</span></div>
      <div class="acts"><button class="chipbtn" id="fbScale">Show the scale</button><button class="chipbtn" id="fbBack">All flybys</button></div><div class="note" style="margin-top:6px">NASA/JPL CNEOS close-approach data. Predictions shift as the orbit is refined.</div>`;
    card.classList.add('show'); card.querySelector('.x').onclick = () => this.close(); $('#fbBack').onclick = () => { this.clearRings(); this.openList(); };
    $('#fbScale').onclick = () => this.scale(r); upd(); clearInterval(this.tick); this.tick = setInterval(upd, 30e3);
  },
  scale(r) {   // the Moon's orbit (and, when it fits, this object's closest distance) as rings round the Earth's centre
    this.clearRings(); const dKm = r.au * AU_KM, fits = dKm < LD_KM * 1.7;
    const ring = (km, rgba, w) => { const pts = []; for (let i = 0; i <= 180; i++) { const a = i / 180 * Math.PI * 2; pts.push(new C.Cartesian3(Math.cos(a) * km * 1000, Math.sin(a) * km * 1000, 0)); } rings.add({ positions: pts, width: w, material: C.Material.fromType('Color', { color: C.Color.fromCssColorString(rgba) }) }); };
    ring(LD_KM, 'rgba(200,210,225,0.55)', 1.5); ring(6371 + 35786, 'rgba(180,140,255,0.5)', 1); if (fits) ring(dKm, 'rgba(255,180,77,0.95)', 2.5);
    state.noHandoff = true;   // this view sits past the Solar System hand-off distance on purpose
    const dir = C.Cartesian3.normalize(new C.Cartesian3(0.35, -1, 0.75), new C.Cartesian3());
    camera.flyTo({ destination: C.Cartesian3.multiplyByScalar(dir, 5.2e8, new C.Cartesian3()), orientation: { direction: C.Cartesian3.negate(dir, new C.Cartesian3()), up: C.Cartesian3.UNIT_Z }, duration: 2.5 });
    toast(fits ? "Grey: the Moon's orbit · orange: how close it comes · violet: geostationary orbit" : `Grey: the Moon's orbit · violet: geostationary. This one passes ${(dKm / LD_KM).toFixed(1)}× further out than the Moon: off this picture`, 7000);
  },
  clearRings() { rings.removeAll(); state.noHandoff = false; },
  close() { clearInterval(this.tick); this.clearRings(); $('#card').classList.remove('show'); },
};
