"""Original soundtrack for the Open Overwatch promo, generated from scratch (numpy only, deterministic).

A dark pulse in the spirit of the app's own Synth: sub drone, 8th-note bass, kick/hats, detuned pads, and
radar "pings" with echoes. A riser leads into the first map shot; every cut gets a whoosh and a hit.

    python make_music.py out.wav [--cuts 3,7.5,11.5,15.5,20,24,28] [--duration 31] [--bpm 120]
"""
import argparse, wave
import numpy as np

SR = 48000
rng = np.random.default_rng(7)


def t_axis(n):
    return np.arange(n) / SR


def env_ad(n, attack, decay):
    t = t_axis(n)
    a = np.clip(t / max(attack, 1e-4), 0, 1)
    return a * np.exp(-np.maximum(t - attack, 0) / max(decay, 1e-4))


def saw(freq, n, harmonics=14, detune_cents=0.0, phase=0.0):
    """Band-limited saw by additive synthesis."""
    t = t_axis(n)
    f = freq * 2 ** (detune_cents / 1200)
    out = np.zeros(n)
    for k in range(1, harmonics + 1):
        if f * k > SR / 2 * 0.9:
            break
        out += np.sin(2 * np.pi * f * k * t + phase * k) / k
    return out * (2 / np.pi)


def fft_filter(x, lo=None, hi=None, slope=4):
    """Zero-phase spectral band filter with soft (Butterworth-like) edges."""
    n = len(x)
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(n, 1 / SR)
    g = np.ones_like(f)
    if hi:
        g *= 1 / np.sqrt(1 + (f / hi) ** (2 * slope))
    if lo:
        g *= 1 / np.sqrt(1 + (np.maximum(lo, 1e-3) / np.maximum(f, 1e-3)) ** (2 * slope))
    return np.fft.irfft(X * g, n)


def convolve(x, ir):
    n = len(x) + len(ir) - 1
    size = 1 << (n - 1).bit_length()
    y = np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(ir, size), size)[:n]
    return y[:len(x)]


def reverb_ir(seconds=2.6, damp=6000):
    n = int(seconds * SR)
    ir = rng.standard_normal(n) * np.exp(-t_axis(n) / (seconds / 6.5))
    ir = fft_filter(ir, lo=200, hi=damp, slope=2)
    ir[:int(0.012 * SR)] = 0  # pre-delay
    return ir / np.sqrt(np.sum(ir ** 2))


def place(buf, sig, at, gain=1.0):
    i = int(at * SR)
    if i >= len(buf):
        return
    j = min(len(buf), i + len(sig))
    if i < 0:
        sig = sig[-i:]; j = min(len(buf), len(sig)); i = 0
    buf[i:j] += sig[:j - i] * gain


def kick(length=0.45):
    n = int(length * SR); t = t_axis(n)
    f = 55 + 110 * np.exp(-t / 0.03)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-t / 0.14) + 0.45 * np.sin(2 * ph) * np.exp(-t / 0.05)
    click = fft_filter(rng.standard_normal(n), lo=1500, hi=6000) * np.exp(-t / 0.004) * 0.25
    return np.tanh(1.6 * (body + click)) * 0.9


def hat(length=0.07, bright=9000):
    n = int(length * SR)
    return fft_filter(rng.standard_normal(n), lo=bright, hi=16000) * np.exp(-t_axis(n) / (length / 4))


def ping(freq=1567.98, length=0.5):
    n = int(length * SR); t = t_axis(n)
    tone = np.sin(2 * np.pi * freq * t) + 0.18 * np.sin(2 * np.pi * freq * 2.01 * t)
    return tone * env_ad(n, 0.002, 0.09)


def echo(sig, delay, feedback, taps, damp=5000):
    out = np.zeros(len(sig) + int(delay * SR * taps) + 1)
    cur = sig.copy()
    for k in range(taps + 1):
        place(out, cur, k * delay, feedback ** k)
        cur = fft_filter(cur, hi=damp, slope=1)
    return out


def whoosh(length=0.6):
    n = int(length * SR); t = t_axis(n)
    noise = rng.standard_normal(n)
    # rising band: split into chunks with increasing cutoff
    out = np.zeros(n); chunks = 12
    for c in range(chunks):
        a, b = c * n // chunks, (c + 1) * n // chunks
        out[a:b] = fft_filter(noise[a:b], lo=300 + 400 * c, hi=1500 + 1100 * c, slope=2)
    return out * (t / length) ** 2.2 * 0.5


def impact(length=2.2):
    n = int(length * SR); t = t_axis(n)
    sub = np.sin(2 * np.pi * (38 + 30 * np.exp(-t / 0.08)) * t) * np.exp(-t / 0.7)
    crash = fft_filter(rng.standard_normal(n), lo=3000, hi=14000) * np.exp(-t / 0.55) * 0.35
    knock = fft_filter(rng.standard_normal(n), lo=150, hi=900) * np.exp(-t / 0.12) * 0.5
    return np.tanh(1.3 * sub) * 0.55 + crash + knock


def riser(length=3.0):
    n = int(length * SR); t = t_axis(n)
    f = 110 * 2 ** (2.5 * t / length)  # sweeps up ~2.5 octaves
    tone = np.sin(2 * np.pi * np.cumsum(f) / SR) * 0.35
    noise = rng.standard_normal(n); out = np.zeros(n); chunks = 24
    for c in range(chunks):
        a, b = c * n // chunks, (c + 1) * n // chunks
        out[a:b] = fft_filter(noise[a:b], lo=200 + 150 * c, hi=900 + 600 * c, slope=2)
    return (tone + out * 0.6) * (t / length) ** 2


NOTE = {'A1': 55.0, 'F1': 43.65, 'D1': 36.71, 'E1': 41.20, 'A2': 110.0, 'C3': 130.81, 'E3': 164.81,
        'F2': 87.31, 'A3': 220.0, 'D3': 146.83, 'F3': 174.61, 'G3': 196.0, 'B3': 246.94, 'C4': 261.63, 'E4': 329.63}
# i - VI - iv - v in A minor, one chord per bar (2 s at 120 bpm)
PROG = [('A1', ['A2', 'C3', 'E3']), ('F1', ['F2', 'A3', 'C4']), ('D1', ['D3', 'F3', 'A3']), ('E1', ['E3', 'G3', 'B3'])]


def build(duration, bpm, cuts):
    n = int(duration * SR)
    beat = 60 / bpm; bar = beat * 4
    drums, bass, pads, fx, pings = (np.zeros(n) for _ in range(5))
    first = cuts[0] if cuts else 3.0
    end = cuts[-1] if cuts else duration - 3

    # pads + drone for the whole piece, chord per bar, slow swell
    bars = int(np.ceil(duration / bar))
    for b in range(bars):
        root, chord = PROG[b % len(PROG)]
        ln = int((bar + 0.6) * SR)
        e = np.minimum(1, t_axis(ln) / 0.5) * np.minimum(1, (bar + 0.6 - t_axis(ln)) / 0.6)
        chord_sig = sum(saw(NOTE[c], ln, 10, d) for c in chord for d in (-7, 7)) / 6
        place(pads, chord_sig * e, b * bar - 0.3, 0.55)
        place(bass, np.sin(2 * np.pi * NOTE[root] * t_axis(ln)) * e, b * bar - 0.3, 0.10)  # sub drone
    pads = fft_filter(pads, lo=140, hi=3200, slope=2)

    # pulse bass (8ths) from the first cut until the end card
    t = first
    while t < end - 1e-6:
        b = int(t // bar); root = PROG[b % len(PROG)][0]
        ln = int(beat / 2 * SR)
        note = saw(NOTE[root] * 2, ln, 8) * env_ad(ln, 0.004, 0.11)
        place(bass, note, t, 0.62)
        t += beat / 2
    bass = fft_filter(bass, hi=1500, slope=2)

    # drums: kick on beats, hats on off-8ths, from the first cut until the end card; 4-on-floor
    t = first
    while t < end - 1e-6:
        place(drums, kick(), t, 0.55)
        place(drums, hat(), t + beat / 2, 0.30)
        place(drums, hat(0.035, 11000), t + beat * 0.75, 0.10)
        t += beat
    # intro: soft kick heartbeat under the riser
    for k in range(int(first / beat)):
        if k % 2 == 0:
            place(drums, kick(0.3), k * beat, 0.35)

    # riser into the first cut, impacts and whooshes on cuts
    rs = riser(first)
    place(fx, rs, 0, 0.55)
    for i, c in enumerate(cuts):
        w = whoosh(0.55)
        place(fx, w, c - 0.55, 0.45 if i else 0.0)
        place(fx, impact(2.2 if i in (0, len(cuts) - 1) else 0.9), c, 0.9 if i in (0, len(cuts) - 1) else 0.35)


    # arp: 16th-note plucks over the chord tones (one and two octaves up), second cut -> end card
    arps = np.zeros(n)
    t = cuts[1] if len(cuts) > 1 else first; k = 0
    while t < end - 1e-6:
        b = int(t // bar); chord = PROG[b % len(PROG)][1]
        f0 = NOTE[chord[k % 3]] * (2 if (k // 3) % 2 == 0 else 4)
        ln = int(0.22 * SR)
        pl = (saw(f0, ln, 6) * 0.6 + np.sin(2 * np.pi * f0 * t_axis(ln))) * env_ad(ln, 0.002, 0.06)
        place(arps, pl, t, 0.16)
        t += beat / 4; k += 1
    arps = fft_filter(arps, lo=250, hi=4500, slope=2)

    # radar pings: on the first beat of every other bar after the first cut, plus the end card
    p = ping()
    t = first; k = 0
    while t < duration - 1:
        if k % 2 == 1:
            place(pings, echo(p, beat * 0.75, 0.45, 5), t, 0.30)
        t += bar; k += 1
    place(pings, echo(ping(2093.0, 0.8), beat * 0.75, 0.55, 7), end, 0.45)

    rv = reverb_ir()
    mix_l = drums + bass * 0.9 + pads * 0.9 + fx + arps
    wet_src = pads * 0.6 + pings + fx * 0.4 + arps * 0.5
    mix_l = mix_l + pings * 0.8 + convolve(wet_src, rv) * 0.55
    # small stereo width: delay the right channel of pads/pings a touch
    shift = int(0.011 * SR)
    mix_r = mix_l.copy()
    width = np.zeros(n); width[shift:] = (pads * 0.4 + pings * 0.5)[:-shift]
    mix_l = mix_l - width * 0.3
    mix_r = mix_r + width * 0.3

    # fade out the last 1.2 s, and the very start in 20 ms
    fade = np.ones(n)
    fo = int(1.2 * SR); fade[-fo:] = np.linspace(1, 0, fo) ** 1.5
    fi = int(0.02 * SR); fade[:fi] = np.linspace(0, 1, fi)
    stereo = np.stack([mix_l * fade, mix_r * fade], axis=1)

    # loudness: aim ~ -15 dBFS RMS, then soft-limit peaks at about -1 dBFS
    rms = np.sqrt(np.mean(stereo ** 2))
    stereo *= 10 ** (-15 / 20) / max(rms, 1e-9)
    ceiling = 10 ** (-1 / 20)
    stereo = np.tanh(stereo / ceiling) * ceiling
    return stereo


def write_wav(path, stereo):
    pcm = (np.clip(stereo, -1, 1) * 32767).astype('<i2')
    with wave.open(path, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(pcm.tobytes())


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('out')
    ap.add_argument('--duration', type=float, default=31.0)
    ap.add_argument('--bpm', type=float, default=120.0)
    ap.add_argument('--cuts', default='3,7.5,11.5,15.5,20,24,28')
    a = ap.parse_args()
    cuts = [float(x) for x in a.cuts.split(',') if x.strip()]
    s = build(a.duration, a.bpm, cuts)
    write_wav(a.out, s)
    peak = 20 * np.log10(np.max(np.abs(s)) + 1e-12); rms = 20 * np.log10(np.sqrt(np.mean(s ** 2)) + 1e-12)
    print(f'wrote {a.out}: {len(s) / SR:.2f} s, peak {peak:.1f} dBFS, rms {rms:.1f} dBFS')
