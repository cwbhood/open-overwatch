// The globe's clock: live (wall clock) or simulated at a rate, shared with the Solar System view across the hand-over.
// Everything time-dependent reads Time.nowMs(): sun lighting and models use Cesium's clock directly, the satellite dots
// ask the worker for positions at this time, and aircraft (live data only) hide when it isn't now.
import { C } from './env.js';
import { viewer } from './viewer.js';
import { hooks } from './state.js';
import { jdFromMs, msFromJd } from '../core/time.js';

const clock = viewer.clock;
const LIVE_SLACK_MS = 120e3;   // within 2 minutes of now at 1x counts as live

export const Time = {
  rate: 1,   // simulated seconds per real second (0 = paused)
  get live() { return clock.clockStep === C.ClockStep.SYSTEM_CLOCK; },
  nowMs() { return this.live ? Date.now() : C.JulianDate.toDate(clock.currentTime).getTime(); },
  jd() { return jdFromMs(this.nowMs()); },
  /** Away from the live moment (the aircraft feeds have no history). */
  offLive() { return !this.live && Math.abs(this.nowMs() - Date.now()) > LIVE_SLACK_MS; },
  goLive() {
    clock.clockStep = C.ClockStep.SYSTEM_CLOCK; clock.multiplier = 1; clock.shouldAnimate = true; this.rate = 1;
    this.changed();
  },
  setRate(r) {
    if (r === 1 && Math.abs(this.nowMs() - Date.now()) < LIVE_SLACK_MS) return this.goLive();
    const t = C.JulianDate.fromDate(new Date(this.nowMs()));          // freeze the current instant before switching steps
    clock.clockStep = C.ClockStep.SYSTEM_CLOCK_MULTIPLIER; clock.currentTime = t;
    clock.multiplier = r || 1; clock.shouldAnimate = r !== 0; this.rate = r;
    this.changed();
  },
  setJd(jd, rate = this.rate) {
    clock.clockStep = C.ClockStep.SYSTEM_CLOCK_MULTIPLIER; clock.currentTime = C.JulianDate.fromDate(new Date(msFromJd(jd)));
    this.setRate(rate);
  },
  listeners: [],
  onChange(fn) { this.listeners.push(fn); },
  changed() { for (const fn of this.listeners) fn(); hooks.applyVisibility(); },
};
