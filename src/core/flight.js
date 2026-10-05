// What someone types to find a plane, turned into what the feeds know. Tickets say "BA 123" (the IATA airline code);
// the transponder says "BAW123" (the ICAO code, no leading zeros). Also accepts a callsign, an ICAO hex address or a
// registration. DOM-free.

// IATA -> ICAO for the airlines people most often look up (not exhaustive: an unknown code is tried as typed)
export const AIRLINES = {
  AA: 'AAL', AC: 'ACA', AF: 'AFR', AI: 'AIC', AK: 'AXM', AM: 'AMX', AS: 'ASA', AV: 'AVA', AY: 'FIN', AZ: 'ITY', B6: 'JBU', BA: 'BAW',
  BR: 'EVA', CA: 'CCA', CI: 'CAL', CM: 'CMP', CX: 'CPA', CZ: 'CSN', DL: 'DAL', DY: 'NOZ', EI: 'EIN', EK: 'UAE', ET: 'ETH', EW: 'EWG',
  EY: 'ETD', F9: 'FFT', FR: 'RYR', FZ: 'FDB', G4: 'AAY', GA: 'GIA', HA: 'HAL', IB: 'IBE', JL: 'JAL', JQ: 'JST', KE: 'KAL', KL: 'KLM',
  LA: 'LAN', LH: 'DLH', LO: 'LOT', LX: 'SWR', MH: 'MAS', MS: 'MSR', MU: 'CES', NH: 'ANA', NK: 'NKS', NZ: 'ANZ', OS: 'AUA', OZ: 'AAR',
  PR: 'PAL', QF: 'QFA', QR: 'QTR', SA: 'SAA', SK: 'SAS', SN: 'BEL', SQ: 'SIA', SV: 'SVA', TG: 'THA', TK: 'THY', TP: 'TAP', U2: 'EZY',
  UA: 'UAL', UX: 'AEA', VA: 'VOZ', VN: 'HVN', VS: 'VIR', VY: 'VLG', W6: 'WZZ', WN: 'SWA', WS: 'WJA', '6E': 'IGO', '9W': 'JAI',
};

/** A callsign as the feeds write it: upper case, no spaces, no leading zeros in the number ("BAW0123 " -> "BAW123"). */
export const normCallsign = s => String(s || '').toUpperCase().replace(/\s+/g, '').replace(/^([A-Z0-9]{2,3}?[A-Z])0+(\d)/, '$1$2');

/**
 * Parse a query. Returns { callsigns: [...], hex, reg, label } (any may be empty) or null if it can't be a plane.
 * "BA 123" -> callsigns ['BAW123', 'BA123']; "baw0123" -> ['BAW123']; "3c6444" -> hex; "G-EUPT" / "N123AB" -> reg.
 */
export function parseFlightQuery(q) {
  const raw = String(q || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!raw || raw.length > 12) return null;
  const out = { callsigns: [], hex: '', reg: '', label: raw };
  if (/^[0-9A-F]{6}$/.test(raw) && /\d/.test(raw)) out.hex = raw.toLowerCase();
  if (/^[A-Z0-9]{1,2}-[A-Z0-9]{2,5}$/.test(raw) || /^N\d{1,5}[A-Z]{0,2}$/.test(raw)) out.reg = raw;
  const m = raw.replace(/[\s-]/g, '').match(/^([A-Z0-9]{2,3}?)(\d{1,4})([A-Z]?)$/);
  if (m) {
    const [, code, num, suffix] = m, n = String(+num) + suffix;
    if (code.length === 2 && AIRLINES[code]) out.callsigns.push(AIRLINES[code] + n);
    if (/^[A-Z]{3}$/.test(code) || code.length === 2) out.callsigns.push(code + n);
  } else if (/^[A-Z0-9]{3,8}$/.test(raw)) out.callsigns.push(raw);
  out.callsigns = [...new Set(out.callsigns)];
  return out.callsigns.length || out.hex || out.reg ? out : null;
}

/** Does a feed record ({ flight, hex, reg }) match a parsed query? */
export function matchesFlight(r, q) {
  if (!q || !r) return false;
  if (q.hex && String(r.hex || '').toLowerCase() === q.hex) return true;
  if (q.reg && String(r.reg || '').toUpperCase().replace(/\s/g, '') === q.reg) return true;
  const cs = normCallsign(r.flight);
  return !!cs && q.callsigns.includes(cs);
}
