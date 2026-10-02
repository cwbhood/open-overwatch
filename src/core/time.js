// Julian Dates and the simulation clock. jd is TT ~ UTC (the 69 s difference is far below anything we draw).

export const J2000 = 2451545.0;
export const UNIX_EPOCH_JD = 2440587.5;
export const REAL_TIME = 1 / 86400;             // clock rate: one simulated day per 86,400 s

export const jdFromMs = ms => ms / 86400000 + UNIX_EPOCH_JD;
export const msFromJd = jd => (jd - UNIX_EPOCH_JD) * 86400000;
export const jdNow = (now = Date.now()) => jdFromMs(now);
export const julianCenturies = jd => (jd - J2000) / 36525;

/** "2026-10-02 04:19 UTC" (or without the suffix). */
export function formatUtc(jd, { suffix = ' UTC' } = {}) {
  const d = new Date(msFromJd(jd));
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(0, 16).replace('T', ' ') + suffix;
}

/**
 * Simulation clock. `rate` is in simulated days per real second; at REAL_TIME and in sync with the wall clock it is
 * "live" and follows Date.now() exactly instead of accumulating frame times.
 */
export class SimClock {
  constructor({ jd, rate = REAL_TIME, min = -Infinity, max = Infinity, now = () => Date.now() } = {}) {
    this.jd = jd ?? jdNow(now()); this.rate = rate; this.min = min; this.max = max; this.now = now;
    this.live = rate === REAL_TIME && Math.abs(this.jd - jdNow(now())) < 1 / 1440;
  }
  setRate(rate) {
    this.rate = rate;
    this.live = rate === REAL_TIME && Math.abs(this.jd - jdNow(this.now())) < 1 / 1440;
    return this;
  }
  goLive() { this.jd = jdNow(this.now()); this.rate = REAL_TIME; this.live = true; return this; }
  setJd(jd) { this.jd = Math.min(this.max, Math.max(this.min, jd)); this.live = false; return this; }
  /** Advance by dt real seconds. */
  tick(dt) {
    this.jd = this.live ? jdNow(this.now()) : this.jd + this.rate * dt;
    if (this.jd < this.min || this.jd > this.max) { this.jd = Math.min(this.max, Math.max(this.min, this.jd)); this.live = false; }
    return this.jd;
  }
}
