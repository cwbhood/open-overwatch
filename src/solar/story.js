// The narrative layer: scale bands with real-world comparisons, the ladder of views, the guided tour, the light pulse
// and the alignment finder.
import * as THREE from 'three';
import { LY_AU, KM_AU, C_KM_S } from '../core/units.js';
import { PLANET_KEYS, planetSpread } from '../core/planets.js';
import { lightTime, distance } from '../core/format.js';
import { formatUtc } from '../core/time.js';
import { surfaceMaterial } from './util.js';
import { byKey } from './world.js';

// [camera distance from the Sun below which this band applies (AU), band name, title, text, comparison]
export const BANDS = [
  [0.03, 'Earth & Moon', 'Earth and the Moon', 'The Moon is 384,400 km away, 1.3 light-seconds. All the other planets would fit side by side in the gap.', 'If Earth were a basketball, the Moon would be a tennis ball 7 m away.'],
  [6, 'Inner Solar System', 'One astronomical unit', '1 AU is the Earth–Sun distance, 150 million km. Sunlight takes 8 min 20 s to reach us.', 'If the Sun were a basketball, Earth would be a 2 mm peppercorn 26 m away.'],
  [20, 'Asteroid belt', 'The asteroid belt', 'Over a million asteroids, yet mostly empty space: neighbours are typically hundreds of thousands of km apart, so spacecraft cross it without trouble.', 'All the asteroids together weigh less than 3% of our Moon.'],
  [120, 'Outer planets', 'The giant planets', 'Neptune orbits 30 AU out. Sunlight takes over 4 hours to get there, and Neptune\'s year is 165 Earth years.', 'Basketball Sun: Jupiter is a 2.4 cm marble 134 m away; Neptune is 780 m away.'],
  [1500, 'Kuiper belt & heliopause', 'The edge of the Sun\'s wind', 'Past Neptune lies the Kuiper belt of icy worlds, then the heliopause, where the solar wind meets interstellar space. Voyager 1 crossed it in 2012.', 'Radio signals to Voyager 1 now take almost a day each way.'],
  [3e5, 'Oort cloud', 'The Oort cloud', 'A vast shell of icy bodies thought to surround the Sun out to 100,000 AU or more: the source of long-period comets. Never seen directly.', 'At 17 km/s, Voyager 1 needs ~300 years to reach its inner edge and ~30,000 years to cross it.'],
  [60 * LY_AU, 'Nearest stars', 'The nearest stars', 'Proxima Centauri is 4.24 light-years away: 268,000 times the Earth–Sun distance. Voyager 1 would need about 75,000 years to get there.', 'Basketball Sun: Proxima would be another basketball 7,000 km away.'],
  [3000 * LY_AU, 'Stellar neighbourhood', 'Our stellar neighbourhood', 'Every dot is a real star from the HYG catalogue, placed in 3D at its measured distance. Almost all the stars you can see at night are within a few thousand light-years.', ''],
  [6e5 * LY_AU, 'Milky Way', 'The Milky Way', '100,000 light-years across with 100–400 billion stars. The Sun sits 26,000 light-years from the centre and takes about 230 million years to go round once.', 'At light speed it would take 100,000 years to cross.'],
  [Infinity, 'Local Group', 'The Local Group', 'Andromeda is 2.5 million light-years away: the light we see from it left before our species existed. Over 80 galaxies belong to this group.', 'Andromeda and the Milky Way will merge in about 4.5 billion years.'],
];

// [ladder label, focus key, distance (AU)]; the label matches a band name so the ladder can light up
export const RUNGS = [
  ['Earth & Moon', 'earth', 0.008], ['Inner Solar System', 'sun', 4.2], ['Asteroid belt', 'sun', 10], ['Outer planets', 'sun', 85],
  ['Kuiper belt & heliopause', 'sun', 190], ['Voyager', 'craft:Voyager 1', 60], ['Oort cloud', 'sun', 2.6e5], ['Nearest stars', 'sun', 22 * LY_AU],
  ['Stellar neighbourhood', 'sun', 400 * LY_AU], ['Milky Way', 'gc', 1.7e5 * LY_AU], ['Local Group', 'gc', 4.2e6 * LY_AU],
];
export const RUNG_SHORT = { 'Inner Solar System': 'Inner planets', 'Kuiper belt & heliopause': 'Kuiper belt', 'Stellar neighbourhood': 'Neighbourhood' };

const TOUR = [ // focus key, distance (AU), title, text, hold (ms)
  ['earth', 0.0016, 'Home', 'Earth, right now: real sunlight, real time. This view is about 100,000 km across.', 5000],
  ['moon', 0.0007, 'The Moon', 'The Moon, 384,400 km away. It looks close in pictures, but 30 Earths fit in between.', 6000],
  ['mars', 0.0004, 'Mars', 'Mars. Depending on where both planets are, it is 55 to 400 million km from us.', 6000],
  ['sun', 4.2, 'The inner planets', 'Mercury, Venus, Earth and Mars, with the asteroid belt beyond.', 6000],
  ['jupiter', 0.012, 'Jupiter', 'Jupiter: 11 Earths wide and more massive than all the other planets put together.', 6000],
  ['saturn', 0.004, 'Saturn', 'Saturn and its rings, which are 280,000 km wide but only about 10 m thick in places.', 6000],
  ['sun', 85, 'The whole planetary system', 'Out to Neptune at 30 AU. Each dot of the belts is a real, catalogued object: 1.5 million of them.', 7000],
  ['craft:Voyager 1', 60, 'Voyager 1', 'Launched in 1977, now the most distant human-made object. Its signals take almost a day to reach us.', 7000],
  ['sun', 2.6e5, 'The Oort cloud', 'A shell of comets out to perhaps 100,000 AU. The Sun is now just a bright star.', 7000],
  ['sun', 22 * LY_AU, 'The nearest stars', 'Proxima Centauri, 4.24 light-years away. Light from it left more than four years ago.', 7000],
  ['gc', 1.7e5 * LY_AU, 'The Milky Way', 'Our galaxy: we orbit 26,000 light-years from its centre.', 8000],
  ['gc', 4.2e6 * LY_AU, 'The Local Group', 'Andromeda, 2.5 million light-years away, and our other neighbours.', 8000],
];

export function createStory({ scene, clock, nav, caption, onTourChange }) {
  // ---- guided tour
  const tour = { on: false, i: 0, timer: 0 };
  function step() {
    if (!tour.on) return; if (tour.i >= TOUR.length) { stopTour(); return; }
    const [k, d, t, p, ms] = TOUR[tour.i]; nav.focusOn(byKey[k] || byKey.sun, d, 3.2, false); caption(t, p, '', ms + 2500, true);
    tour.timer = setTimeout(() => { tour.i++; step(); }, ms + 3200);
  }
  function startTour() { stopPulse(); tour.on = true; tour.i = 0; clock.goLive(); onTourChange(true); step(); }
  function stopTour() { if (!tour.on) return; tour.on = false; clearTimeout(tour.timer); onTourChange(false); }

  // ---- light pulse: a shell expanding from the Sun at c (sped up 60x), announcing each planet it reaches
  const pulse = { on: false, t0: 0, passed: new Set(), zoomed: false, speed: 60 };
  const shell = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), surfaceMaterial({
    uniforms: { k: { value: 1 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    frag: { decl: 'uniform float k;', body: 'col = vec3(1.0, 0.88, 0.55) * pow(1.0 - abs(dot(normalize(vN), normalize(-vP))), 8.0) * k * 1.1;' },
  }));
  shell.visible = false; scene.add(shell);
  function startPulse() {
    stopTour(); Object.assign(pulse, { on: true, t0: performance.now(), zoomed: false }); pulse.passed.clear(); shell.visible = true;
    nav.focusOn(byKey.sun, 3.2, 2.5, false);
    caption('Light from the Sun', 'Sped up 60 times: real light takes 8 min 20 s to reach Earth and over 4 hours to reach Neptune.', '', 6000, true);
  }
  function stopPulse() { pulse.on = false; shell.visible = false; }
  function updatePulse() {
    if (!pulse.on) return;
    const r = (performance.now() - pulse.t0) / 1000 * pulse.speed * C_KM_S * KM_AU;
    shell.scale.setScalar(Math.max(r, 1e-6)); shell.material.uniforms.k.value = Math.max(0, 1 - r / 40);
    for (const k of PLANET_KEYS) {
      const b = byKey[k], rb = b.pos.length();
      if (!pulse.passed.has(k) && r >= rb) { pulse.passed.add(k); caption('Light reached ' + b.name, 'after ' + lightTime(rb) + ' of real time', distance(rb) + ' from the Sun', 5000, true); }
    }
    if (pulse.passed.size === 3 && !pulse.zoomed) { pulse.zoomed = true; nav.flyDist(45, 6); }
    if (r > 40) stopPulse();
  }

  // ---- alignment: the tightest grouping of all eight planets (seen from the Sun) in the next 100 years
  function findAlignment() {
    stopPulse(); stopTour();
    const from = clock.jd + 30, to = Math.min(from + 36525, 2488069.5);   // stop at 2100: the formulae are only good to ~2050
    let best = 1e9, bestJd = from;
    for (let jd = from; jd < to; jd += 3) { const s = planetSpread(jd); if (s < best) { best = s; bestJd = jd; } }
    for (let jd = bestJd - 3; jd < bestJd + 3; jd += 0.25) { const s = planetSpread(jd); if (s < best) { best = s; bestJd = jd; } }
    clock.setJd(bestJd); clock.setRate(0);
    nav.focusOn(byKey.sun, 70, 2.5, false);
    caption('Planetary alignment · ' + formatUtc(bestJd).slice(0, 10), `All eight planets sit within ${best.toFixed(0)}° of each other around the Sun, the tightest grouping before 2100 (planets never line up exactly).`, 'Press ▶ to start the clock again, or NOW to come back to today.', 14000, true);
  }

  return { tour, startTour, stopTour, pulse, startPulse, stopPulse, updatePulse, findAlignment };
}
