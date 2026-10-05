// Who is in space right now: Launch Library 2 astronauts with in_space=true (the site build copies them into
// data/astronauts.json; a page without the copy asks the API). Which station each is on isn't in this list, so it is
// inferred: China's crews fly to Tiangong, everyone else (on long missions) to the ISS. "Starman", the mannequin in a Tesla
// launched in 2018, is in the list as "Non-Human": kept, but never counted as a person. DOM-free.

/** ISO 8601 duration ("P438DT5H49M19S") -> days. */
export function durationDays(s) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(String(s || ''));
  return m ? (+m[1] || 0) + (+m[2] || 0) / 24 + (+m[3] || 0) / 1440 + (+m[4] || 0) / 86400 : null;
}

const flag = iso => /^[A-Z]{2}$/.test(iso) ? String.fromCodePoint(...[...iso].map(c => 0x1F1E6 + c.charCodeAt(0) - 65)) : '';

/** One LL2 astronaut -> { name, agency, countries: ['US'], flag, days (career total), since (ms, this flight), human, wiki }. */
export function fromLL2Astronaut(r) {
  const countries = (r.nationality || []).map(n => n.alpha_2_code).filter(c => /^[A-Z]{2}$/.test(c || ''));
  const wiki = typeof r.wiki === 'string' && /^https:\/\/[a-z]+\.wikipedia\.org\/wiki\/[^\s"'<>]+$/.test(r.wiki) ? r.wiki : null;
  return { name: String(r.name || '').slice(0, 80), agency: String((r.agency && (r.agency.abbrev || r.agency.name)) || ''), countries, flag: countries.map(flag).join(''),
    days: durationDays(r.time_in_space), since: Date.parse(r.last_flight) || null, human: !(r.type && /non-human/i.test(r.type.name || '')), wiki };
}

/** Group the people by where they are: { total, stations: [{ name, crew: [...] }], other: [...] }. */
export function whoIsUp(list) {
  const people = list.filter(p => p.human), tiangong = people.filter(p => p.agency === 'CNSA'), iss = people.filter(p => p.agency !== 'CNSA');
  const stations = [{ name: 'International Space Station', short: 'ISS', crew: iss }, { name: 'Tiangong', short: 'Tiangong', crew: tiangong }].filter(s => s.crew.length);
  return { total: people.length, stations, other: list.filter(p => !p.human) };
}

/** "10 people are in space right now: 7 on the ISS and 3 on Tiangong." */
export function crewSentence(w) {
  if (!w.total) return 'Nobody is listed in space right now.';
  const parts = w.stations.map(s => `${s.crew.length} on ${s.short === 'ISS' ? 'the ISS' : s.short}`);
  return `${w.total} ${w.total === 1 ? 'person is' : 'people are'} in space right now: ${parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1] : parts[0]}.`;
}
