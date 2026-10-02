// Human-readable distances, durations and safe HTML.

import { AU_KM, LY_AU, C_KM_S } from './units.js';

export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 1.2 million / 3.45 billion / 12,345 */
export function bigNumber(n) {
  if (n >= 1e12) return (n / 1e12).toFixed(2) + ' trillion';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' billion';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' million';
  return Math.round(n).toLocaleString('en-US');
}

/** A distance given in AU, in the unit people think in at that scale. */
export function distance(au) {
  if (au < 0.01) return Math.round(au * AU_KM).toLocaleString('en-US') + ' km';
  if (au < 2000) return (au < 10 ? au.toFixed(3) : au.toFixed(1)) + ' AU · ' + bigNumber(au * AU_KM) + ' km';
  const ly = au / LY_AU;
  return (ly < 10 ? ly.toFixed(2) : Math.round(ly).toLocaleString('en-US')) + ' light-years';
}

/** The width of a view (AU) for the scale readout. */
export function viewWidth(au) {
  if (au < 1e-3) return Math.round(au * AU_KM).toLocaleString('en-US') + ' km';
  if (au < 0.05) return bigNumber(au * AU_KM) + ' km';
  if (au < 3000) return (au < 10 ? au.toFixed(2) : Math.round(au).toLocaleString('en-US')) + ' AU';
  const ly = au / LY_AU;
  if (ly < 1e6) return (ly < 10 ? ly.toFixed(2) : Math.round(ly).toLocaleString('en-US')) + ' light-years';
  return (ly / 1e6).toFixed(2) + ' million light-years';
}

/** How long light takes to cross a distance in AU: "8 min 19 s", "23.5 h", "4.2 years". */
export function lightTime(au) {
  const s = au * AU_KM / C_KM_S;
  if (s < 60) return s.toFixed(1) + ' s';
  if (s < 3600) return Math.floor(s / 60) + ' min ' + Math.round(s % 60) + ' s';
  if (s < 86400 * 2) return (s / 3600).toFixed(1) + ' h';
  if (s < 86400 * 365.25 * 2) return (s / 86400).toFixed(1) + ' days';
  return (s / 86400 / 365.25).toLocaleString('en-US', { maximumFractionDigits: 1 }) + ' years';
}

/** An orbital period in days: "88 days", "11.9 years", "248 years". */
export function period(days) { return days < 1000 ? Math.round(days) + ' days' : (days / 365.25).toFixed(days > 36525 ? 0 : 1) + ' years'; }
