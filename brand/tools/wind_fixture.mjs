// A made-up wind and temperature grid in the shape of data/wind.json (the site build's Open-Meteo mirror), for the phone
// journeys: they serve it in place of the real file and block Open-Meteo itself, whose per-IP hourly limit (612 lookups
// per weather open) a few test runs used to exhaust, after which wind silently stopped drawing.
export function windFixture() {
  const u = [], v = [], temp = [], rad = Math.PI / 180;
  for (let la = -80; la <= 80; la += 10) for (let lo = -180; lo < 180; lo += 10) {
    u.push(+(-12 * Math.cos(la * 3 * rad) * (Math.abs(la) > 25 ? 1 : -0.6) + 2 * Math.sin(lo * 2 * rad)).toFixed(2));
    v.push(+(5 * Math.sin((lo * 3 + la) * rad)).toFixed(2)); temp.push(+(30 * Math.cos(la * rad) - 15).toFixed(1));
  }
  return { t: Date.now(), at: 'test fixture', u, v, temp };
}
