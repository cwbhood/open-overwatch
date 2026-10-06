// Share a picture: the globe exactly as it is on screen, with a caption strip (what you're looking at, when, and the
// site's address), handed to the phone's share sheet with the link to this view, or saved as a PNG on a desktop.
// The WebGL canvas keeps no copy of its last frame, so the picture is taken inside postRender, before it is presented.
import { $, toast, loadImage } from './env.js';
import { scene } from './viewer.js';
import { state } from './state.js';
import { Time } from './time.js';
import { LookUp } from './lookup.js';
import { Share } from './share.js';

const SITE = 'destinjones.github.io/open-overwatch';
const EMBLEM = loadImage('brand/emblem/emblem-256.png').catch(() => null);   // ready before the tap: share sheets want the tap's activation

function frame() {
  return new Promise(res => {
    const once = () => {
      scene.postRender.removeEventListener(once);
      const src = scene.canvas, c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
      c.getContext('2d').drawImage(src, 0, 0); res(c);
    };
    scene.postRender.addEventListener(once); scene.requestRender();
  });
}

function subject() {
  const o = state.selected;
  if (LookUp.active) return 'My sky right now';
  if (o && o.kind === 'air') return `${o.flight || o.hex}${o.ground ? ' · on the ground' : ` · ${Math.round((o.alt || 0) / 0.3048).toLocaleString()} ft`}`;
  if (o && (o.name || o.place)) return o.name || o.place;
  return `${$('#bandName').textContent} · ${$('#bandAlt').textContent}`;
}

async function compose() {
  const shot = await frame(), W = Math.min(shot.width, 1600), k = W / shot.width, H0 = Math.round(shot.height * k);
  const portrait = H0 > W, bar = Math.round(W * (portrait ? 0.2 : 0.105)), out = document.createElement('canvas');
  out.width = W; out.height = H0 + bar;
  const g = out.getContext('2d'); g.drawImage(shot, 0, 0, W, H0);
  g.fillStyle = '#05080c'; g.fillRect(0, H0, W, bar); g.fillStyle = '#7dffa6'; g.fillRect(0, H0, W, Math.max(2, Math.round(bar * 0.03)));
  const pad = Math.round(bar * 0.16), big = Math.round(bar * (portrait ? 0.2 : 0.24)), small = Math.round(big * 0.62);   // three lines fit: pad + big + 2.9 small + descenders
  const when = new Date(Time.nowMs()).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const counts = [['#sSat', 'satellites'], ['#sAir', 'aircraft']].map(([id, w]) => { const t = $(id) && $(id).textContent; return t && t !== '—' ? `${t} ${w}` : ''; }).filter(Boolean).join(' · ');
  const emblem = await EMBLEM, e = Math.round(bar * 0.5);
  g.textBaseline = 'alphabetic';
  g.fillStyle = '#e6edf3'; g.font = `700 ${big}px system-ui, sans-serif`; g.fillText(subject(), pad, H0 + pad + big, W * 0.62);
  g.fillStyle = '#8b9bab'; g.font = `500 ${small}px ui-monospace, monospace`;
  g.fillText(`${when}${Time.offLive() ? ' (simulated time)' : ' · live'}`, pad, H0 + pad + big + small * 1.5, W * 0.62);
  if (counts) g.fillText(counts, pad, H0 + pad + big + small * 2.9, W * 0.62);
  g.textAlign = 'right';
  const right = W - pad - (emblem ? e + pad * 0.6 : 0);
  g.fillStyle = '#7dffa6'; g.font = `800 ${small}px system-ui, sans-serif`; g.fillText('OPEN OVERWATCH', right, H0 + bar / 2 - small * 0.2);
  g.fillStyle = '#8b9bab'; g.font = `500 ${Math.round(small * 0.85)}px ui-monospace, monospace`; g.fillText(SITE, right, H0 + bar / 2 + small * 1.1);
  if (emblem) g.drawImage(emblem, W - pad - e, H0 + (bar - e) / 2, e, e);
  return new Promise(res => out.toBlob(res, 'image/png'));
}

export const Snapshot = {
  busy: false,
  async share() {
    if (this.busy) return; this.busy = true;
    try {
      const blob = await compose(); if (!blob) throw new Error('no image');
      const link = Share.link(), file = new File([blob], `open-overwatch-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.png`, { type: 'image/png' });
      const text = `${subject()} · live on Open Overwatch`;
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: 'Open Overwatch', text: `${text}\n${link}` }); return; }
        catch (e) { if (e.name === 'AbortError') return; }   // cancelled: fine. Anything else: fall back to a download
      }
      const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = file.name; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10e3);
      try { await navigator.clipboard.writeText(link); toast('Picture saved · link to this view copied too', 4000); } catch (e) { toast('Picture saved', 3000); }
    } catch (e) { console.warn('snapshot', e); toast('Could not make the picture: ' + e.message, 4000); }
    finally { this.busy = false; }
  },
};
