// The generative soundtrack and the radio player.
import { $, $$, Log, Net, Sound, Store, cssVar, esc, hexA, isHttp, toast } from './util.js';
import { map } from './mapview.js';
import { Dyn } from './engine.js';

/* ============================================================ AUDIO: generative soundtrack (original, synthesized live) + underground radio */
export const Synth = {
  SETS: {
    underground: { name: 'Underground', desc: 'Dark half-time beat, sub bass, static', bpm: 92, drums: true, half: true, hats: .55, arp: .12, cut: 900 },
    drift: { name: 'Drift', desc: 'Beatless drones and slow pads', bpm: 60, drums: false, half: false, hats: 0, arp: .18, cut: 600 },
    pulse: { name: 'Pulse', desc: 'Driving 124 techno, rolling bass', bpm: 124, drums: true, half: false, hats: .8, arp: .3, cut: 1400 },
  },
  // D minor territory: roots for the pad/bass progression (Hz for octave 2) and a pentatonic minor for blips
  PROG: [[36.71, [0, 3, 7, 10]], [29.14, [0, 4, 7, 11]], [43.65, [0, 4, 7, 9]], [32.70, [0, 4, 7, 10]]], // D, Bb, F, C
  PENTA: [0, 3, 5, 7, 10, 12, 15, 17],
  set: 'underground', step: 0, next: 0, timer: null, live: false, n: {},
  density: .5, brightness: 0, // reactive inputs from the map (0..1)
  start(ctx, out) {
    if (this.live) return; this.ctx = ctx; this.out = out; this.step = 0; this.next = ctx.currentTime + .1; // live is set once the graph is built, so a throw here can be retried
    const n = this.n = {};
    // noise buffer (pink-ish)
    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0); let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; b0 = .997 * b0 + .029 * w; b1 = .985 * b1 + .032 * w; b2 = .95 * b2 + .05 * w; d[i] = (b0 + b1 + b2 + w * .1) * .3; }
    n.noise = buf;
    // bus: pad + drone + arp + drums → master
    n.bus = ctx.createGain(); n.bus.gain.value = .9;
    n.lp = ctx.createBiquadFilter(); n.lp.type = 'lowpass'; n.lp.frequency.value = this.SETS[this.set].cut; n.lp.Q.value = .7;
    n.delay = ctx.createDelay(1.5); n.delay.delayTime.value = 60 / this.SETS[this.set].bpm * .75; n.fb = ctx.createGain(); n.fb.gain.value = .32; n.wet = ctx.createGain(); n.wet.gain.value = .28;
    n.delay.connect(n.fb).connect(n.delay); n.delay.connect(n.wet).connect(out);
    n.bus.connect(n.lp).connect(out); n.lp.connect(n.delay);
    // static bed
    n.bed = ctx.createBufferSource(); n.bed.buffer = buf; n.bed.loop = true; n.bedF = ctx.createBiquadFilter(); n.bedF.type = 'bandpass'; n.bedF.frequency.value = 900; n.bedF.Q.value = .6;
    n.bedG = ctx.createGain(); n.bedG.gain.value = .0; n.bed.connect(n.bedF).connect(n.bedG).connect(out); n.bed.start();
    n.bedG.gain.setTargetAtTime(.05, ctx.currentTime, 4);
    n.bedLfo = ctx.createOscillator(); n.bedLfo.frequency.value = .07; n.bedLfoG = ctx.createGain(); n.bedLfoG.gain.value = .03; n.bedLfo.connect(n.bedLfoG).connect(n.bedG.gain); n.bedLfo.start();
    // pad: 3 detuned saws through the bus
    n.pad = [0, 1, 2].map(i => { const o = ctx.createOscillator(); o.type = i === 1 ? 'triangle' : 'sawtooth'; o.detune.value = [-7, 0, 6][i]; const g = ctx.createGain(); g.gain.value = 0; o.connect(g).connect(n.bus); o.start(); return { o, g }; });
    // drone: sub sine + soft square an octave up
    n.drone = ['sine', 'square'].map((t, i) => { const o = ctx.createOscillator(); o.type = t; const g = ctx.createGain(); g.gain.value = 0; o.connect(g).connect(n.bus); o.start(); return { o, g }; });
    this.chord(0, ctx.currentTime, 3);
    this.live = true; this.timer = setInterval(() => this.schedule(), 40);
  },
  stop() {
    if (!this.live) return; this.live = false; clearInterval(this.timer); const ctx = this.ctx, t = ctx.currentTime, n = this.n;
    try { n.bus.gain.setTargetAtTime(0, t, .4); n.bedG.gain.setTargetAtTime(0, t, .4); n.wet.gain.setTargetAtTime(0, t, .4); } catch (e) { }
    setTimeout(() => { try { for (const k of ['bed', 'bedLfo']) n[k].stop(); n.pad.forEach(p => p.o.stop()); n.drone.forEach(p => p.o.stop()); n.bus.disconnect(); n.bedG.disconnect(); n.wet.disconnect(); n.lp.disconnect(); n.delay.disconnect(); n.fb.disconnect(); } catch (e) { } }, 1500); // incl. the delay↔feedback loop, which would keep itself alive
  },
  use(set) { this.set = set; if (this.live) { const s = this.SETS[set]; this.n.lp.frequency.setTargetAtTime(s.cut, this.ctx.currentTime, .5); this.n.delay.delayTime.setTargetAtTime(60 / s.bpm * .75, this.ctx.currentTime, .5); } },
  chord(i, t, glide = 1.5) {
    const [root, iv] = this.PROG[i % this.PROG.length]; const n = this.n;
    n.pad.forEach((p, k) => { const f = root * 4 * Math.pow(2, iv[k + 1] / 12); p.o.frequency.setTargetAtTime(f, t, glide); p.g.gain.setTargetAtTime(.05, t, 2.5); });
    n.drone[0].o.frequency.setTargetAtTime(root * 2, t, glide); n.drone[0].g.gain.setTargetAtTime(.16, t, 2); n.drone[1].o.frequency.setTargetAtTime(root * 4, t, glide); n.drone[1].g.gain.setTargetAtTime(.02, t, 2);
    this.root = root;
  },
  schedule() {
    const ctx = this.ctx, s = this.SETS[this.set]; const spb = 60 / s.bpm / 4; // seconds per 16th
    while (this.next < ctx.currentTime + .18) { this.play(this.step, this.next, s, spb); this.next += spb; this.step++; }
  },
  play(i, t, s, spb) {
    const ctx = this.ctx, n = this.n, st = i % 16, bar = Math.floor(i / 16);
    if (st === 0 && bar % 8 === 0) this.chord(Math.floor(bar / 8), t);
    const hatDensity = s.hats * (.6 + .5 * this.density);
    if (s.drums) {
      const kick = s.half ? (st === 0 || st === 10 || (bar % 4 === 3 && st === 13)) : (st % 4 === 0);
      if (kick) this.kick(t, s.half ? 1 : .85);
      const snare = s.half ? st === 8 : (st === 4 || st === 12); if (snare) this.snare(t, s.half ? .5 : .32);
      if (st % 2 === 1 && Math.random() < hatDensity) this.hat(t, .07 + .05 * Math.random(), st % 4 === 3 && Math.random() < .3);
      if (!s.half && st % 2 === 0) this.bass(t, spb * .9, st % 4 === 0 ? 0 : (st === 6 || st === 14 ? 7 : 12), .12);
      if (s.half && (st === 0 || st === 10 || st === 11 && bar % 2)) this.bass(t, spb * 3, 0, .18);
    }
    if (Math.random() < s.arp * (.5 + this.brightness) && st % 4 === 2) this.blip(t, spb * 2);
  },
  env(g, t, a, d, peak) { g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(.0001, t + a + d); },
  kick(t, v) { const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(42, t + .12); this.env(g, t, .004, .34, .9 * v); o.connect(g).connect(this.out); o.start(t); o.stop(t + .4); },
  snare(t, v) { const ctx = this.ctx, src = ctx.createBufferSource(); src.buffer = this.n.noise; const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 1800; const g = ctx.createGain(); this.env(g, t, .002, .16, v); src.connect(f).connect(g).connect(this.out); src.start(t); src.stop(t + .25); const o = ctx.createOscillator(); o.frequency.setValueAtTime(190, t); o.frequency.exponentialRampToValueAtTime(120, t + .08); const g2 = ctx.createGain(); this.env(g2, t, .002, .09, v * .5); o.connect(g2).connect(this.out); o.start(t); o.stop(t + .15); },
  hat(t, v, open) { const ctx = this.ctx, src = ctx.createBufferSource(); src.buffer = this.n.noise; const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000; const g = ctx.createGain(); this.env(g, t, .001, open ? .22 : .045, v); src.connect(f).connect(g).connect(this.out); src.start(t); src.stop(t + .3); },
  bass(t, len, semis, v) { const ctx = this.ctx, o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = (this.root || 36.71) * 2 * Math.pow(2, semis / 12); const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(600 + 900 * this.brightness, t); f.frequency.exponentialRampToValueAtTime(120, t + len); const g = ctx.createGain(); this.env(g, t, .01, len, v); o.connect(f).connect(g).connect(this.n.bus); o.start(t); o.stop(t + len + .1); },
  blip(t, len) { const ctx = this.ctx, o = ctx.createOscillator(); o.type = 'sine'; const semi = this.PENTA[Math.floor(Math.random() * this.PENTA.length)]; o.frequency.value = (this.root || 36.71) * 16 * Math.pow(2, semi / 12); const g = ctx.createGain(); this.env(g, t, .01, len, .05); o.connect(g).connect(this.n.bus); o.start(t); o.stop(t + len + .1); },
};

export const Radio = { // directory: radio-browser.info (community-maintained, open API); streams belong to their broadcasters
  TAGS: ['dark ambient', 'ambient', 'techno', 'dub techno', 'drum and bass', 'jungle', 'idm', 'downtempo', 'trip hop', 'dub', 'industrial', 'synthwave', 'lofi', 'breakbeat', 'deep house', 'psytrance'],
  HOSTS: ['all', 'de1', 'de2'], cache: {}, // all.api… resolves to whichever mirrors are live (nl1/at1/fi1 are gone); de1/de2 as named fallbacks tag: Store.get('radio_tag', 'dark ambient'),
  tidy(name) { // some directory entries carry keyword-stuffed names; keep the first clause, capped
    let s = String(name || '').replace(/^[\s#\-–—|>*]+/, '').replace(/\s+/g, ' ').trim();
    if (s.length > 42) { const re = /\s[-–—|:]\s|\s-{2,}|\s\|\|/g; let m; while ((m = re.exec(s))) { if (m.index > 8) { s = s.slice(0, m.index).trim(); break; } } }
    if (s.length > 42) s = s.slice(0, 40).trim() + '…';
    return s || 'Unnamed station';
  },
  async list(tag) {
    if (this.cache[tag] && Date.now() - this.cache[tag].t < 3600e3) return this.cache[tag].list; let err;
    for (const h of this.HOSTS) { try { const d = await Net.json(`https://${h}.api.radio-browser.info/json/stations/bytag/${encodeURIComponent(tag)}?limit=14&hidebroken=true&order=clickcount&reverse=true`, { timeout: 12000 }); const list = (d || []).filter(x => isHttp(x.url_resolved || x.url)).map(x => ({ id: x.stationuuid, name: Radio.tidy(x.name), url: x.url_resolved || x.url, codec: x.codec, bitrate: x.bitrate, country: x.countrycode, homepage: x.homepage, tags: (x.tags || '').split(',').slice(0, 4).join(', ') })); this.cache[tag] = { t: Date.now(), list }; return list; } catch (e) { err = err || e; } }
    throw new Error(`radio directory unreachable (tried ${this.HOSTS.join(', ')}.api.radio-browser.info${err && !/CORS|offline/.test(err.message) ? ': ' + err.message : ''})`); // a dead host looks like a CORS error to the browser
  },
};
export const Music = {
  mode: Store.get('music_mode', 'synth'), set: (s => Object.keys(Synth.SETS).includes(s) ? s : 'underground')(Store.get('music_set', 'underground')), vol: Store.get('music_vol', .55), auto: Store.get('music_auto', true),
  // a saved station must be a {name,url} object with an http(s) url (older builds stored a plain id — ignore those)
  station: (s => (s && typeof s === 'object' && typeof s.url === 'string' && /^https?:\/\//i.test(s.url)) ? s : null)(Store.get('music_station', null)),
  ctx: null, master: null, analyser: null, playing: false, audio: null, busy: false, radioState: '',
  ensure() {
    if (this.ctx) return; const ctx = this.ctx = Sound.ctx || new (window.AudioContext || window.webkitAudioContext)(); // share the alert chime's context rather than orphaning it
    this.master = ctx.createGain(); this.master.gain.value = this.vol; this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 128; this.analyser.smoothingTimeConstant = .82;
    this.master.connect(this.analyser).connect(ctx.destination); Sound.ctx = ctx;
  },
  async start() {
    if (this.playing || this.busy) return; this.busy = true; let st = null, again = false;
    try {
      this.ensure();
      if (this.mode === 'radio') { if (!this.station || typeof this.station.url !== 'string') { this.station = null; this.mode = 'synth'; toast('Pick a station first — playing the generated set meanwhile'); } else {
        st = this.station; if (this.ctx.state === 'running') this.ctx.suspend(); // the stream plays outside the context
        await this.startRadio();
        // another station or the generated set was picked while this one connected: drop it and start that instead
        if (this.mode !== 'radio' || this.station !== st) { this.dropRadio(); again = true; return; }
      } }
      if (this.mode === 'synth') { if (this.ctx.state === 'suspended') await this.ctx.resume(); Synth.use(this.set); Synth.start(this.ctx, this.master); }
      this.playing = true; this.vis(); this.ui(); Log.info(this.mode === 'radio' ? `Radio: ${this.station.name}` : `Soundtrack: ${Synth.SETS[this.set].name} (generated live)`);
    } catch (e) { if (st && (this.mode !== 'radio' || this.station !== st)) again = true; else if (!e.cancelled) toast('Audio failed to start: ' + e.message, 'alert'); this.ui(); }
    finally { this.busy = false; if (again) this.start(); }
  },
  // also cancels a station that is still connecting; once the synth has faded, the context is suspended (Sound.ping resumes it)
  stop() {
    if (!this.playing && !this.audio) return; this.playing = false; Synth.stop(); this.dropRadio(); this.ui();
    setTimeout(() => { if (this.ctx && this.ctx.state === 'running' && !this.busy && !(this.playing && this.mode === 'synth')) this.ctx.suspend(); }, 1700);
  },
  dropRadio() { const a = this.audio; this.audio = null; this.radioState = ''; if (a) { try { a.pause(); a.src = ''; } catch (e) { } } },
  toggle() { const on = !(this.playing || this.busy); if (on) this.start(); else this.stop(); Store.set('music_auto', this.auto = on); }, // the intent, not this.playing (a station starts async)
  startRadio() {
    return new Promise((resolve, reject) => {
      const a = this.audio = new Audio(); a.preload = 'none'; a.volume = this.vol; const st = this.station; this.radioState = 'connecting…'; this.ui();
      let started = false; const to = setTimeout(() => fail(`"${st.name}" is not answering — pick another station`), 20000);
      // before play() resolves a failure rejects start(); after it (stream dropped or ended) it stops the player and says so; a dropped element rejects as cancelled
      const fail = msg => {
        clearTimeout(to); if (this.audio !== a) { if (!started) reject(Object.assign(new Error('cancelled'), { cancelled: true })); return; }
        this.dropRadio(); if (!started) { reject(new Error(msg)); return; }
        this.playing = false; this.ui(); toast(`Radio stopped: ${msg}`, 'alert');
      };
      a.addEventListener('error', () => fail(started ? `"${st.name}" dropped the stream` : `"${st.name}" is not answering — pick another station`));
      a.addEventListener('ended', () => fail(`"${st.name}" ended the stream`));
      a.addEventListener('waiting', () => { if (this.audio === a) { this.radioState = 'buffering…'; this.ui(false); } }); a.addEventListener('playing', () => { if (this.audio === a) { this.radioState = ''; this.ui(false); } });
      a.src = st.url; a.load(); a.play().then(() => { if (this.audio !== a) return fail(); clearTimeout(to); started = true; resolve(); }).catch(err => fail(err.name === 'NotAllowedError' ? 'the browser wants a click first' : 'stream unavailable (' + err.message + ')'));
    });
  },
  setMode(m) { const was = this.playing; this.stop(); this.mode = m; Store.set('music_mode', m); if (was && (m === 'synth' || this.station)) this.start(); this.ui(); },
  setSet(id) { this.set = id; Store.set('music_set', id); Synth.use(id); if (this.mode !== 'synth') { this.mode = 'synth'; Store.set('music_mode', 'synth'); if (this.playing || this.audio) { this.stop(); this.start(); } } this.ui(); },
  setStation(st) { this.station = st; Store.set('music_station', st); this.mode = 'radio'; Store.set('music_mode', 'radio'); if (this.playing || this.audio) this.stop(); this.start(); },
  setVol(v) { this.vol = v; Store.set('music_vol', v); if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, .05); if (this.audio) this.audio.volume = v; },
  react() { // the soundtrack listens to the map: traffic density → hats, zoom → brightness
    const b = map.getBounds(); let inView = 0; for (const a of Dyn.air.values()) if (a.lat != null && b.contains([a.lat, a.lon])) inView++;
    Synth.density = Math.min(1, inView / 400); Synth.brightness = Math.min(1, Math.max(0, (map.getZoom() - 3) / 9));
  },
  label() { return this.audio && this.radioState && !this.playing ? this.radioState : !this.playing ? 'audio off' : this.mode === 'radio' ? (this.radioState || (this.station && this.station.name) || 'radio') : Synth.SETS[this.set].name; },
  ui(full = true) { // full=false (stream buffering events) updates the labels only: rebuilding the popover would detach a slider mid-drag
    const b = $('#btnAudio'); if (b) { b.classList.toggle('on', this.playing); $('.alabel', b).textContent = this.label(); }
    const pop = $('#audioPop'); if (full && pop && !pop.hidden) this.renderPop();
    const hud = $('#hudAudio'); if (hud) hud.textContent = this.playing ? `▶ ${this.label()}` : '';
  },
  async renderPop() {
    const pop = $('#audioPop'); const on = this.playing || this.busy; // a connecting station shows Stop, which cancels it
    pop.innerHTML = `<div class="ahead"><span class="label">Soundtrack</span><button class="btn small ${on ? 'on' : 'primary'}" id="apPlay">${on ? '■ Stop' : '▶ Play'}</button></div>
      <div class="amodes"><button class="amode ${this.mode === 'synth' ? 'on' : ''}" data-mode="synth"><b>Generated</b><small>original, synthesized live, reacts to the map</small></button><button class="amode ${this.mode === 'radio' ? 'on' : ''}" data-mode="radio"><b>Radio</b><small>underground stations from the open directory</small></button></div>
      ${this.mode === 'synth' ? `<div class="alist">${Object.entries(Synth.SETS).map(([id, s]) => `<button class="aitem ${this.set === id ? 'on' : ''}" data-set="${id}"><span class="aname">${esc(s.name)}</span><span class="adesc">${esc(s.desc)}</span><span class="atag">${s.bpm} bpm</span></button>`).join('')}</div>`
      : `<div class="atags">${Radio.TAGS.map(t => `<button class="pill ${Radio.tag === t ? 'on' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}</div><div class="alist" id="apStations"><div class="acredit">Loading stations…</div></div><p class="acredit">Directory by <a href="https://www.radio-browser.info/" target="_blank" rel="noopener">radio-browser.info</a>; streams belong to their broadcasters. Some stations refuse to play outside their own site — pick another.</p>`}
      <div class="avol"><span class="label">Volume</span><input type="range" id="apVol" min="0" max="1" step="0.02" value="${this.vol}"><label class="acheck"><input type="checkbox" id="apAuto" ${this.auto ? 'checked' : ''}> start with the page</label></div>`;
    $('#apPlay').addEventListener('click', () => this.toggle());
    $$('.amode', pop).forEach(b => b.addEventListener('click', () => { if (b.dataset.mode !== this.mode) this.setMode(b.dataset.mode); }));
    $$('[data-set]', pop).forEach(b => b.addEventListener('click', () => { this.setSet(b.dataset.set); if (!this.playing) this.start(); }));
    $$('[data-tag]', pop).forEach(b => b.addEventListener('click', () => { Radio.tag = b.dataset.tag; Store.set('radio_tag', Radio.tag); this.renderPop(); }));
    $('#apVol').addEventListener('input', e => this.setVol(+e.target.value));
    $('#apAuto').addEventListener('change', e => { this.auto = e.target.checked; Store.set('music_auto', this.auto); });
    if (this.mode === 'radio') {
      const box = $('#apStations'); try { const list = await Radio.list(Radio.tag); if (!box.isConnected) return;
        box.innerHTML = list.length ? list.map(st => `<button class="aitem ${this.station && this.station.url === st.url ? 'on' : ''}" data-st="${esc(st.id)}"><span class="aname">${esc(st.name)}</span><span class="adesc">${esc([st.tags, st.country].filter(Boolean).join(' · '))}</span><span class="atag">${esc((st.codec || '').toLowerCase())} ${st.bitrate ? st.bitrate + 'k' : ''}</span></button>`).join('') : '<div class="acredit">No stations for this tag.</div>';
        $$('[data-st]', box).forEach(b => b.addEventListener('click', () => { const st = list.find(x => x.id === b.dataset.st); if (st) this.setStation({ name: st.name, url: st.url, homepage: st.homepage }); }));
      } catch (e) { if (box.isConnected) box.innerHTML = `<div class="acredit">Station directory unavailable: ${esc(e.message)}</div>`; }
    }
  },
  togglePop() { const pop = $('#audioPop'); pop.hidden = !pop.hidden; if (!pop.hidden) this.renderPop(); },
  vis() {
    // one loop at a time: a stop+start in the same task never lets the old loop see !playing, so it just keeps running
    const cv = $('#vis'); if (!cv || this.visOn) return; this.visOn = true; const ctx2 = cv.getContext('2d'); const W = cv.width, H = cv.height; const bars = 18; const data = new Uint8Array(this.analyser.frequencyBinCount); let phase = 0;
    const frame = () => {
      if (!this.playing) { this.visOn = false; ctx2.clearRect(0, 0, W, H); return; }
      requestAnimationFrame(frame); if (document.hidden) return;
      ctx2.clearRect(0, 0, W, H); const col = cssVar('--vibe');
      if (this.mode === 'synth') { this.analyser.getByteFrequencyData(data); for (let i = 0; i < bars; i++) { const v = data[Math.floor(i * data.length / bars * .6)] / 255; const h = Math.max(1, v * H); ctx2.fillStyle = hexA(col, .35 + v * .65); ctx2.fillRect(i * (W / bars), H - h, W / bars - 1.5, h); } }
      else { phase += .06; for (let i = 0; i < bars; i++) { const v = .25 + .35 * Math.abs(Math.sin(phase + i * .7)) + .25 * Math.abs(Math.sin(phase * 1.7 + i * 1.3)); const h = v * H; ctx2.fillStyle = hexA(col, .3 + v * .5); ctx2.fillRect(i * (W / bars), H - h, W / bars - 1.5, h); } }
    };
    frame();
  },
};
setInterval(() => { if (Music.playing && Music.mode === 'synth') Music.react(); }, 3000);
