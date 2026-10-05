// Alerts without a server: a calendar file with a reminder (reaches the phone with the site closed), and browser
// notifications while the page is open (re-armed from localStorage on the next visit). Phones only show page
// notifications through a service worker (notify-sw.js, which does nothing else); iPhones only for a home-screen app.
import { toast, store } from './env.js';
import { makeIcs } from '../core/ics.js';

const MAX_WAIT = 2 ** 31 - 1;   // setTimeout's limit (~24.8 days)
let reg = null; const timers = new Map();

async function permission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'default') { try { await Notification.requestPermission(); } catch (e) { return false; } }
  if (Notification.permission !== 'granted') return false;
  if (!reg && navigator.serviceWorker) reg = await navigator.serviceWorker.register('src/globe/notify-sw.js').catch(() => null);
  return true;
}

function show(title, body, tag) {
  const o = { body, tag, icon: 'brand/emblem/emblem-256.png', badge: 'brand/emblem/emblem-256.png', data: { url: location.href.split('#')[0] } };
  const fallback = () => { try { new Notification(title, o); } catch (e) { toast(`${title} · ${body}`, 12000); } };
  if (reg) reg.showNotification(title, o).catch(fallback); else fallback();
}

function arm(a) {
  clearTimeout(timers.get(a.tag));
  const wait = a.at - Date.now();
  if (wait < -60e3 || wait > MAX_WAIT) return;
  timers.set(a.tag, setTimeout(() => { show(a.title, a.body, a.tag); Alerts.forget(a.tag); }, Math.max(0, wait)));
}

export const Alerts = {
  get list() { return store.get('alerts', []).filter(a => a.at > Date.now() - 60e3); },
  has(tag) { return this.list.some(a => a.tag === tag); },
  /** Notify at `at` (ms) while this page is open. Returns false (with a message) if notifications are blocked. */
  async remind(a) {
    if (!(await permission())) { toast('Notifications are blocked or not supported here: use "Add to calendar" instead', 5000); return false; }
    store.set('alerts', [...this.list.filter(x => x.tag !== a.tag), a]); arm(a);
    toast(`Reminder set for ${new Date(a.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · keep this tab open (or add it to your calendar)`, 5000);
    return true;
  },
  forget(tag) { clearTimeout(timers.get(tag)); timers.delete(tag); store.set('alerts', this.list.filter(a => a.tag !== tag)); },
  /** Notify now (aurora watch). */
  async now(title, body, tag) { if (await permission()) show(title, body, tag); else toast(`${title} · ${body}`, 12000); },
  permission,
  /** Download a calendar file: [{ uid, start, end, title, details, alarmMin }]. */
  calendar(events, name = 'sky-alert.ics') {
    const url = URL.createObjectURL(new Blob([makeIcs(events)], { type: 'text/calendar' })), a = document.createElement('a');
    a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10e3);
    const m = events[0] && events[0].alarmMin; toast(`Calendar file saved: open it to add the event${m != null ? ` (reminder ${m} minutes before)` : ''}`, 5000);
  },
  /** Re-arm saved reminders (page load). */
  init() { const l = this.list; store.set('alerts', l); for (const a of l) arm(a); if (l.length && 'Notification' in window && Notification.permission === 'granted') permission(); },
};
