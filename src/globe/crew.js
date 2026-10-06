// "Who's in space right now": the people aboard the ISS and Tiangong (Launch Library 2, copied by the site build into
// data/astronauts.json; without the copy the page asks the API once). A card of its own, a line in Tonight, and
// "aboard now" on the station cards.
import { $, esc } from './env.js';
import { state, hooks } from './state.js';
import { fetchAsset } from '../core/assets.js';
import { fromLL2Astronaut, whoIsUp, crewSentence } from '../core/crew.js';

const API = 'https://ll.thespacedevs.com/2.3.0/astronauts/?in_space=true&mode=normal&limit=60';
const since = ms => ms ? new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '';

export const Crew = {
  w: null, loading: null, failedAt: 0,
  load() {
    if (!this.loading && Date.now() - this.failedAt > 5 * 60e3) this.loading = (async () => {   // after a failure, wait 5 minutes (every station card select would otherwise refetch)
      let d = await fetchAsset('data/astronauts.json', 'json').catch(() => null);
      if (!d || !d.results) { const r = await fetch(API); if (!r.ok) throw new Error('HTTP ' + r.status); d = await r.json(); }
      this.w = whoIsUp((d.results || []).map(fromLL2Astronaut)); return this.w;
    })().catch(e => { this.loading = null; this.failedAt = Date.now(); throw e; });
    return this.loading || Promise.reject(new Error('crew: backing off'));
  },
  sentence() { return this.w ? crewSentence(this.w) : ''; },
  /** People on one station ('ISS' / 'Tiangong'), or []. */
  aboard(short) { const s = this.w && this.w.stations.find(x => x.short === short); return s ? s.crew : []; },
  row(p) {
    const name = p.wiki ? `<a href="${esc(p.wiki)}" target="_blank" rel="noopener">${esc(p.name)}</a>` : esc(p.name);
    return `<div class="tn-row"><span>${p.flag} <b>${name}</b> · ${esc(p.agency)}${p.days != null ? ` · ${Math.round(p.days).toLocaleString('en-US')} days in space in all` : ''}${p.since ? ` · up since ${esc(since(p.since))}` : ''}</span></div>`;
  },
  async open({ back = null } = {}) {
    const c = $('#card'); if (hooks.clearSelection) hooks.clearSelection(); else state.selected = null;
    c.innerHTML = '<button class="x" aria-label="Close">×</button><div class="k" style="--c:#7dffa6">Launch Library 2</div><h2>People in space</h2><p class="note" data-wait="crew">Loading…</p>'; c.classList.add('show');
    c.querySelector('.x').onclick = () => c.classList.remove('show');
    let w; try { w = await this.load(); } catch (e) { const n = c.querySelector('[data-wait="crew"]'); if (n) n.textContent = "The crew list isn't reachable right now."; return; }
    if (!c.querySelector('[data-wait="crew"]') || !c.classList.contains('show')) return;   // another card opened, or Esc, while this loaded
    c.innerHTML = `<button class="x" aria-label="Close">×</button><div class="k" style="--c:#7dffa6">Right now · Launch Library 2</div><h2>People in space</h2>
      <p class="tn-head">${esc(crewSentence(w))}</p>
      ${w.stations.map(s => `<h3>${esc(s.name)} · ${s.crew.length}</h3><div class="tn-list">${s.crew.map(p => this.row(p)).join('')}</div>`).join('')}
      ${w.other.length ? `<p class="note" style="margin-top:8px">Also listed: ${w.other.map(p => esc(p.name)).join(', ')} (not a person: the mannequin in the Tesla launched in 2018, now orbiting the Sun).</p>` : ''}
      <p class="note">Who is on which station is inferred: China's astronauts fly to Tiangong, the others to the ISS. Times in space are career totals.</p>
      ${back ? '<div class="acts"><button class="chipbtn" id="crewBack" style="color:#7dffa6">← Back to tonight</button></div>' : ''}`;
    c.querySelector('.x').onclick = () => c.classList.remove('show');
    if (back) c.querySelector('#crewBack').onclick = back;
  },
};
