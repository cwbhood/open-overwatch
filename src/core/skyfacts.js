// What you're looking at in the sky, in one or two sentences: distances and light travel times for the planets and the
// Moon (from where they are at jd), and for the brightest stars (distances in light-years from Hipparcos/Gaia, rounded).
// DOM-free.
import { planetPosition, earthPosition, moonGeocentric, PHYSICAL } from './planets.js';
import { AU_KM } from './units.js';

export const STAR_LY = { Sirius: 8.6, Canopus: 310, Arcturus: 37, Vega: 25, Capella: 43, Rigel: 860, Procyon: 11.5, Betelgeuse: 550, Achernar: 139, Hadar: 390,
  Altair: 16.7, Acrux: 320, Aldebaran: 65, Antares: 550, Spica: 250, Pollux: 34, Fomalhaut: 25, Deneb: 2600, Regulus: 79, Polaris: 430 };
const STAR_NOTE = { Sirius: 'The brightest star in the night sky.', Betelgeuse: 'A red supergiant near the end of its life: one day it will explode as a supernova.',
  Polaris: 'The Pole Star: it barely moves, because Earth\'s axis points almost straight at it. Due north is under it.', Vega: 'In about 12,000 years it will be our pole star.',
  Deneb: 'One of the most luminous stars we can see by eye: about 200,000 times brighter than the Sun.', Antares: 'A red supergiant so big that it would swallow Mars\'s orbit.',
  Rigel: 'A blue supergiant, about 120,000 times as luminous as the Sun.', 'Alpha Centauri': 'The nearest star system to the Sun.' };
const PLANET_NOTE = { mercury: 'The smallest planet, and the closest to the Sun: never far from it in our sky.', venus: 'Wrapped in clouds of sulphuric acid, the hottest planet (465 °C). The brightest thing in the sky after the Sun and Moon.',
  mars: 'The red planet: its rust-coloured dust shows even to the eye.', jupiter: 'The largest planet: 1,300 Earths would fit inside. Binoculars show its four big moons as tiny dots in a line.',
  saturn: 'Any small telescope shows its rings.', uranus: 'Just visible to the eye from a very dark site.', neptune: 'Needs binoculars or a telescope.' };

const lightTime = km => { const s = km / 299792.458; return s < 120 ? `${s.toFixed(1)} seconds` : s < 7200 ? `${Math.round(s / 60)} minutes` : `${(s / 3600).toFixed(1)} hours`; };
const big = km => km >= 1e9 ? `${(km / 1e9).toFixed(2)} billion km` : km >= 1e6 ? `${Math.round(km / 1e6).toLocaleString('en-US')} million km` : `${Math.round(km).toLocaleString('en-US')} km`;

/** A planet ('mars'...) or 'moon' at jd: one paragraph. */
export function bodyFact(key, jd) {
  if (key === 'moon') {
    const m = moonGeocentric(jd), km = Math.hypot(m.x, m.y, m.z) * AU_KM;
    return `The Moon: ${big(km)} away, its light takes ${lightTime(km)} to reach you. A quarter of Earth's width; the only other world people have walked on.`;
  }
  const p = planetPosition(key, jd), E = earthPosition(jd), km = Math.hypot(p.x - E.x, p.y - E.y, p.z - E.z) * AU_KM, name = PHYSICAL[key] ? PHYSICAL[key].name : key;
  return `${name}: ${big(km)} away right now. The light you see left it ${lightTime(km)} ago. ${PLANET_NOTE[key] || ''}`.trim();
}

/** A bright star by name, seen in `year`: one paragraph. */
export function starFact(name, year = new Date().getUTCFullYear()) {
  const ly = STAR_LY[name]; if (!ly) return name;
  const left = Math.round(year - ly);
  const when = left > 0 ? `The light reaching your eyes left it in ${ly < 120 ? '' : 'about '}${left < 1000 ? 'AD ' : ''}${left}.` : `The light reaching your eyes left it around ${Math.round(-left / 100) * 100 || 1} BC.`;
  return `${name}: ${ly < 20 ? ly : Math.round(ly).toLocaleString('en-US')} light-years away. ${when} ${STAR_NOTE[name] || ''}`.trim();
}
