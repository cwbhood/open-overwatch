// "What am I looking at?": one friendly sentence for a satellite card, from its name, its layer and its orbit. DOM-free.

const NAMED = [
  [/^ISS\b|ZARYA/, 'The International Space Station: a football-pitch-sized lab with people aboard since 2000. Often the brightest thing in the night sky after the Moon and Venus.'],
  [/^CSS|TIANHE|TIANGONG/, "China's Tiangong space station, crewed since 2021."],
  [/^HST$|HUBBLE/, 'The Hubble Space Telescope, photographing the universe from above the blur of the air since 1990.'],
  [/^NOAA|^METOP|^GOES|^HIMAWARI|^METEOSAT|^FENGYUN|^FY-/, 'A weather satellite: its pictures and soundings feed the forecasts you check every day.'],
  [/^GPS|NAVSTAR/, 'A GPS satellite. Your phone hears at least four of these at once to work out where you are.'],
  [/^GALILEO|^GSAT0/, "One of Europe's Galileo navigation satellites (Europe's GPS)."],
  [/^COSMOS 2\d{3} \(GLONASS|GLONASS/, "A GLONASS satellite, Russia's version of GPS."],
  [/^BEIDOU/, "A BeiDou satellite, China's version of GPS."],
  [/^STARLINK/, "One of SpaceX's Starlink internet satellites: thousands fly in shells around 550 km up, beaming broadband to dishes on the ground."],
  [/^ONEWEB/, "A OneWeb internet satellite, part of a constellation 1,200 km up."],
  [/^IRIDIUM/, 'An Iridium satellite: satellite phones and pagers anywhere on Earth, poles included.'],
  [/^LANDSAT/, 'A Landsat Earth-imaging satellite, part of the longest continuous record of Earth from space (since 1972).'],
  [/^SENTINEL/, "One of Europe's Copernicus Sentinel satellites, watching land, sea, ice and air."],
  [/ R\/B$/, 'A spent rocket stage: it delivered a satellite and was left in orbit. Big and shiny, so often easy to see.'],
  [/ DEB$|DEB\b/, 'A piece of debris: one of thousands of fragments from collisions, explosions or weapons tests, each a hazard at orbital speed.'],
];

/** sat: { name, layer }, orbit: { alt (km), period (min) } -> a sentence. */
export function explainSat(sat, orbit = {}) {
  const name = String(sat.name || '').toUpperCase(), hit = NAMED.find(([re]) => re.test(name));
  if (hit) return hit[1];
  const alt = orbit.alt, per = orbit.period;
  if (sat.layer === 'debris') return NAMED[NAMED.length - 1][1];
  if (alt > 34000 && alt < 37500) return 'A geostationary satellite: 35,786 km up it circles once a day, so it seems to hang still over one spot. TV, weather and communications live here.';
  if (alt > 18000 && alt < 24000) return 'A satellite in medium orbit (around 20,000 km), where the navigation constellations fly.';
  if (alt != null && alt < 2000) return `A satellite in low orbit, ${Math.round(alt).toLocaleString('en-US')} km up, going round the Earth every ${Math.round(per || 95)} minutes at about 27,000 km/h.`;
  return 'A satellite in orbit. Its name comes from the official catalogue (US Space Force data, via CelesTrak).';
}

/** Which ocean (or sea) a point at sea is in, roughly: good enough for "the ISS is over the Pacific". */
export function oceanAt(lat, lon) {
  const x = ((lon + 540) % 360) - 180;
  if (lat > 66) return 'the Arctic Ocean';
  if (lat < -60) return 'the Southern Ocean';
  if (lat > 30 && lat < 46 && x > -6 && x < 37) return 'the Mediterranean';
  if (x >= 20 && x < 147 && lat < 30 && !(x > 100 && lat > -10)) return 'the Indian Ocean';
  if (x >= -70 && x < 20) return 'the Atlantic Ocean';
  if (x >= -100 && x < -70 && lat > 8) return 'the Atlantic Ocean';   // Gulf of Mexico and the Caribbean
  return 'the Pacific Ocean';
}
