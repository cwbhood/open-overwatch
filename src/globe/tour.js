// A guided tour, about 80 seconds: the weather, a country dossier, the world's big employers, a volcano, a lighthouse, the aurora,
// the street, then out through the Solar System. Any touch, key or wheel stops it and puts the layers back as they were.
import { C, $, toast } from './env.js';
import { camera } from './viewer.js';
import { L, syncDock } from './layers.js';
import { hooks } from './state.js';
import { Weather } from './weather.js';
import { Country } from './country.js';
import { Space } from './space.js';
import { select, closeCard } from './ui.js';
import { Lighthouses } from './lighthouses.js';
import { Volcanoes } from './volcanoes.js';
import { Companies } from './companies.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
let running = false, cancel = false, cap = null, saved = null;
const say = (t, sub = '') => { cap.innerHTML = `<b>${t}</b>${sub ? `<span>${sub}</span>` : ''}`; cap.classList.add('show'); };
const fly = (lon, lat, h, pitch = -90, dur = 4, heading = 0) => cancel ? Promise.resolve() : new Promise(res => camera.flyTo({ destination: C.Cartesian3.fromDegrees(lon, lat, h), orientation: { heading: C.Math.toRadians(heading), pitch: C.Math.toRadians(pitch), roll: 0 }, duration: dur, complete: res, cancel: res }));
const wait = async ms => { for (let t = 0; t < ms && !cancel; t += 100) await sleep(100); };
const layers = (on, off = []) => { for (const id of on) L[id].on = true; for (const id of off) L[id].on = false; hooks.applyVisibility(); syncDock(); };

async function script() {
  say('A live Earth', '18,000 satellites, in the places they really are right now');
  layers(['stations', 'visual', 'gnss', 'starlink'], ['companies', 'volcanoes', 'lighthouses']); await fly(-30, 25, 2.2e7, -90, 3); await wait(5500); if (cancel) return;
  say('Weather, live', 'Infrared clouds from weather satellites, rain radar, and the wind');
  Weather.sets.ir.on = true; Weather.sets.radar.on = true; Weather.sets.wind.on = true; await Weather.open(); if (cancel) return; Weather.build(); Weather.show(); await fly(-60, 30, 2.0e7, -90, 3); await wait(8500); if (cancel) return;
  Weather.close(); say('Click any country', 'Facts, what is happening there, its biggest employers'); layers(['companies']); await Companies.load(); if (cancel) return;
  await fly(139, 36, 4.5e6, -90, 4); const jp = cancel ? null : await Country.at(139, 36); if (jp && !cancel) select(jp); await wait(7500); if (cancel) return;
  closeCard(); say('The biggest employers', 'Towers: height is people employed, colour is the industry'); await fly(15, 38, 1.8e7, -62, 4); await wait(6500); if (cancel) return;
  layers([], ['companies']); layers(['volcanoes']); await Volcanoes.load(); say('Volcanoes', 'About 2,500 of them, from Wikidata'); await fly(-19, 63.4, 1.2e6, -55, 4); await wait(5000); if (cancel) return;
  layers([], ['volcanoes']); layers(['lighthouses']); await Lighthouses.load(); say('Lighthouses', '14,901, with their light patterns and ranges'); await fly(-9.6, 51.15, 120000, -40, 4); await wait(5000); if (cancel) return;
  layers(['aurora']); say('The aurora, live', "NOAA's forecast of where it can be seen tonight"); await fly(-30, 64, 1.5e7, -90, 4); await wait(5500); if (cancel) return;
  say('Street level', 'London'); await fly(-0.1278, 51.495, 3200, -45, 5); await wait(4500); if (cancel) return;
  say('And out…', 'Past the Moon, to the planets, the stars, the galaxies'); Space.go(); await wait(7000);
}
export const Tour = {
  get running() { return running; },
  async start() {
    if (running) return this.stop();
    if (!cap) { cap = document.createElement('div'); cap.id = 'tourcap'; cap.className = 'glass'; document.body.append(cap); }
    running = true; cancel = false; saved = Object.fromEntries(Object.entries(L).map(([k, v]) => [k, v.on]));
    const stop = e => { if (e.type === 'keydown' && e.key !== 'Escape') return; cancel = true; camera.cancelFlight(); };   // the flight in progress resolves at once
    const evs = ['pointerdown', 'wheel', 'keydown']; for (const ev of evs) addEventListener(ev, stop, { capture: true, passive: true });
    document.body.classList.add('touring'); toast('Tour: touch the screen or press Esc to stop', 3500);
    try { await script(); } catch (e) { console.warn('tour', e); }
    for (const ev of evs) removeEventListener(ev, stop, { capture: true });
    if (cancel) { camera.cancelFlight(); }
    if (Weather.on) Weather.close();
    for (const [k, v] of Object.entries(saved)) L[k].on = v; hooks.applyVisibility(); syncDock();
    cap.classList.remove('show'); document.body.classList.remove('touring'); running = false;
  },
  stop() { cancel = true; },
};
