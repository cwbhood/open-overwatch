// cdp.mjs — a tiny Chrome DevTools Protocol client for headless Microsoft Edge (or Chrome).
// Node 22+, no packages: uses the built-in WebSocket and child_process.
//
//   import { launch } from './cdp.mjs';
//   const browser = await launch();                 // fresh temp profile, --headless=new, --remote-debugging-port=0
//   const page = await browser.newPage();           // a flattened CDP session on a new tab
//   await page.send('Page.navigate', { url });
//   const off = page.on('Page.loadEventFired', () => {});
//   const v = await page.eval('1 + 1');             // Runtime.evaluate, returns the value
//   await browser.close();                          // closes and kills ONLY the Edge this launch() started
//
// close() never touches other msedge.exe processes: it asks the browser to close over CDP, then kills the
// process tree of the PID it spawned, and finally any leftover process whose command line contains this
// launch's unique --user-data-dir. The temporary profile directory is deleted afterwards.

import { spawn, execFile, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// Working folder for temp profiles, footage and caches; set OW_WORK to use another one.
export const WORK = process.env.OW_WORK || ((process.env.LOCALAPPDATA || process.env.HOME || '.') + '\\open-overwatch-brand');

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** One WebSocket to the browser endpoint; sessions are multiplexed on it (Target.attachToTarget flatten:true). */
class Connection {
  constructor(ws) {
    this.ws = ws; this.nextId = 1; this.pending = new Map(); this.handlers = new Map(); this.closed = false;
    ws.addEventListener('message', e => this._onMessage(e.data));
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(new Error(`CDP connection closed (pending ${p.method})`));
      this.pending.clear();
    });
  }
  _onMessage(data) {
    let msg; try { msg = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8')); } catch (e) { return; }
    if (msg.id != null) {
      const p = this.pending.get(msg.id); if (!p) return; this.pending.delete(msg.id); clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}${msg.error.data ? ' (' + msg.error.data + ')' : ''}`)); else p.resolve(msg.result);
      return;
    }
    if (msg.method) {
      for (const key of [`${msg.sessionId || ''}|${msg.method}`, `*|${msg.method}`]) {
        const set = this.handlers.get(key); if (!set) continue;
        for (const h of [...set]) { try { h(msg.params, msg.sessionId); } catch (e) { console.error('[cdp] handler error', msg.method, e); } }
      }
    }
  }
  send(method, params = {}, sessionId, timeoutMs = 60000) {
    if (this.closed) return Promise.reject(new Error(`CDP connection closed (send ${method})`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method}: timed out after ${timeoutMs} ms`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      const msg = { id, method, params }; if (sessionId) msg.sessionId = sessionId;
      this.ws.send(JSON.stringify(msg));
    });
  }
  /** Subscribe to an event. sessionId '' = browser-level events, '*' = any session. Returns an unsubscribe function. */
  on(method, handler, sessionId = '') {
    const key = `${sessionId}|${method}`; if (!this.handlers.has(key)) this.handlers.set(key, new Set());
    this.handlers.get(key).add(handler); return () => this.handlers.get(key)?.delete(handler);
  }
  waitFor(method, { sessionId = '', predicate = () => true, timeoutMs = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      const off = this.on(method, (params) => { if (predicate(params)) { clearTimeout(t); off(); resolve(params); } }, sessionId);
      const t = setTimeout(() => { off(); reject(new Error(`waitFor ${method}: timed out after ${timeoutMs} ms`)); }, timeoutMs);
    });
  }
}

/** A CDP session attached to one page target. */
export class Session {
  constructor(conn, sessionId, targetId) { this.conn = conn; this.sessionId = sessionId; this.targetId = targetId; }
  send(method, params = {}, timeoutMs) { return this.conn.send(method, params, this.sessionId, timeoutMs); }
  on(method, handler) { return this.conn.on(method, handler, this.sessionId); }
  waitFor(method, opts = {}) { return this.conn.waitFor(method, { ...opts, sessionId: this.sessionId }); }
  /** Runtime.evaluate with awaitPromise + returnByValue; throws on a page exception. */
  async eval(expression, { timeoutMs = 60000, awaitPromise = true } = {}) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: false }, timeoutMs);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails; const m = d.exception?.description || d.exception?.value || d.text;
      throw new Error('page error: ' + String(m).split('\n').slice(0, 4).join(' | '));
    }
    return r.result?.value;
  }
  /** Poll a page expression until it is truthy (returns its value) or the timeout passes (returns the last value). */
  async poll(expression, { timeoutMs = 30000, intervalMs = 250 } = {}) {
    const t0 = Date.now(); let v;
    while (Date.now() - t0 < timeoutMs) { try { v = await this.eval(expression); if (v) return v; } catch (e) { v = undefined; } await sleep(intervalMs); }
    return v;
  }
  async screenshotPng({ optimizeForSpeed = true } = {}) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false, optimizeForSpeed }, 60000);
    return Buffer.from(r.data, 'base64');
  }
  close() { return this.conn.send('Target.closeTarget', { targetId: this.targetId }).catch(() => { }); }
}

function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
function powershell(script) {
  return new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20000 },
    (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') })));
}
function taskkillTree(pid) {
  return new Promise(resolve => execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15000 }, () => resolve()));
}

export class Browser {
  constructor({ proc, conn, ws, userDataDir, port, exe }) { Object.assign(this, { proc, conn, ws, userDataDir, port, exe }); this.closed = false; this._exitHook = null; }
  send(method, params, timeoutMs) { return this.conn.send(method, params, undefined, timeoutMs); }
  on(method, handler) { return this.conn.on(method, handler, ''); }
  async newPage(url = 'about:blank') {
    const { targetId } = await this.send('Target.createTarget', { url });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return new Session(this.conn, sessionId, targetId);
  }
  /** PIDs of processes started with this launch's unique profile directory (and only those). */
  async ownPids() {
    const r = await powershell(`Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains(${psQuote(this.userDataDir)}) } | ForEach-Object { $_.ProcessId }`);
    return r.stdout.split(/\s+/).map(Number).filter(n => n > 0);
  }
  async close({ keepProfile = false } = {}) {
    if (this.closed) return; this.closed = true;
    try { if (!this.conn.closed) await Promise.race([this.send('Browser.close', {}, 5000), sleep(5000)]); } catch (e) { }
    try { this.ws.close(); } catch (e) { }
    const exited = () => this.proc.exitCode != null || this.proc.signalCode != null;
    for (let i = 0; i < 50 && !exited(); i++) await sleep(100);
    if (!exited()) await taskkillTree(this.proc.pid);             // the PID we spawned, and its children only
    for (let i = 0; i < 3; i++) {                                    // stragglers launched with OUR profile dir only
      const left = await this.ownPids(); if (!left.length) break;
      for (const pid of left) await taskkillTree(pid);
      await sleep(500);
    }
    if (this._exitHook) { process.off('exit', this._exitHook); this._exitHook = null; }
    if (!keepProfile) {
      for (let i = 0; i < 10; i++) { try { await rm(this.userDataDir, { recursive: true, force: true }); break; } catch (e) { await sleep(500); } }
    }
  }
}

/**
 * Launch headless Edge with a fresh temporary profile and connect to it.
 * @param {object} o
 * @param {string} [o.exe] browser executable (default: Edge)
 * @param {string} [o.profileRoot] where the edge-profile-* temp dir is created (default: WORK)
 * @param {boolean} [o.headless=true]
 * @param {string[]} [o.args] extra command-line switches
 * @param {[number, number]} [o.windowSize]
 */
export const CHROME = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
/**
 * Browsers left behind by a script that was killed hard (Windows TerminateProcess skips 'exit' handlers, so close()
 * and the exit hook never ran): their main process still runs a profile under WORK but its parent script is gone.
 * Killed once per run, before launching (a session of timed-out test runs had left ~100 of them, 992 processes).
 */
let reaped = false;
function reapOrphans() {
  if (reaped || process.platform !== 'win32') return; reaped = true;
  const ps = `$w = '${WORK.replace(/'/g, "''")}'; $all = Get-CimInstance Win32_Process; $ids = @{}; $all | ForEach-Object { $ids[$_.ProcessId] = 1 };
    $all | Where-Object { ($_.Name -eq 'msedge.exe' -or $_.Name -eq 'chrome.exe') -and $_.CommandLine -like ('*' + $w + '*edge-profile-*') -and $_.CommandLine -notlike '*--type=*' -and -not $ids.ContainsKey([int]$_.ParentProcessId) } | ForEach-Object { $_.ProcessId }`;
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    const pids = (r.stdout || '').split(/\s+/).filter(Boolean);
    for (const pid of pids) spawnSync('taskkill.exe', ['/PID', pid, '/T', '/F'], { windowsHide: true });
    if (pids.length) console.error(`[cdp] killed ${pids.length} orphaned browser(s) from earlier runs`);
  } catch (e) { /* best effort */ }
}
/** Launch Edge (or OO_BROWSER_EXE); if Edge exits at once (it does mid-update), retry once with Chrome. */
export async function launch(o = {}) {
  reapOrphans();
  const exe = o.exe || process.env.OO_BROWSER_EXE || EDGE;
  try { return await launchOnce({ ...o, exe }); }
  catch (e) { if (exe !== EDGE || !/exited early/.test(e.message)) throw e; return launchOnce({ ...o, exe: CHROME }); }
}
async function launchOnce({ exe = EDGE, profileRoot = WORK, headless = true, args = [], windowSize = [540, 960], timeoutMs = 30000 } = {}) {
  await mkdir(profileRoot, { recursive: true });
  const userDataDir = await mkdtemp(path.join(profileRoot, 'edge-profile-'));
  const argv = [
    headless ? '--headless=new' : null,
    `--user-data-dir=${userDataDir}`, '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', '--disable-default-apps', '--disable-extensions', '--disable-sync',
    '--disable-component-update', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--disable-features=Translate,msEdgeSidebarV2,msUndersideButton,EdgeCollections',
    '--hide-scrollbars', '--mute-audio', '--force-color-profile=srgb', `--window-size=${windowSize[0]},${windowSize[1]}`,
    ...args, 'about:blank',
  ].filter(Boolean);
  const proc = spawn(exe, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  proc.stderr.on('data', d => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-8000); });
  proc.stdout.on('data', () => { });
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  let port = 0, wsPath = '';
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (proc.exitCode != null) break;
    try { const [p, w] = (await readFile(portFile, 'utf8')).split(/\r?\n/); if (+p > 0 && w) { port = +p; wsPath = w.trim(); break; } } catch (e) { }
    await sleep(100);
  }
  const fail = async (msg) => {
    if (proc.exitCode == null) await taskkillTree(proc.pid);
    try { await rm(userDataDir, { recursive: true, force: true }); } catch (e) { }
    throw new Error(msg + (stderr ? ' · stderr: ' + stderr.slice(-400) : ''));
  };
  if (!port) await fail(proc.exitCode != null ? `browser exited early (code ${proc.exitCode})` : 'DevToolsActivePort never appeared');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  try {
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', () => reject(new Error('WebSocket error')), { once: true }); setTimeout(() => reject(new Error('WebSocket open timeout')), 10000); });
  } catch (e) { await fail('could not connect to DevTools: ' + e.message); }
  const browser = new Browser({ proc, conn: new Connection(ws), ws, userDataDir, port, exe });
  // last-resort cleanup if the script dies without calling close(): kill just our process tree
  browser._exitHook = () => { if (!browser.closed && proc.exitCode == null) { try { spawnSync('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }); } catch (e) { } } };
  process.on('exit', browser._exitHook);
  return browser;
}
