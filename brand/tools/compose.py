"""Assemble the vertical promo frame by frame (Pillow + numpy), then hand the frames to encode_video.py.

    python compose.py [--work DIR] [--only 0-120] [--preview]

Timeline (30 fps, 1080x1920): globe intro with the animated emblem and the wordmark, six live-map shots with
captions, then the end card. Cut times must match the soundtrack (make_music.py --cuts).
"""
import argparse, json, os, math
import numpy as np
from PIL import Image, ImageEnhance, ImageFilter

FPS, W, H = 30, 1080, 1920
DEFAULT_WORK = os.environ.get('OW_WORK') or os.path.join(os.environ.get('LOCALAPPDATA', os.path.expanduser('~')), 'open-overwatch-brand')
BRAND = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))

INTRO = 3.5
SHOTS = [('air_world', 4.5), ('air_dense', 4.0), ('mil', 4.0), ('space', 4.5), ('hazards', 4.0), ('ui', 4.0)]
END = 3.0
CUTS = [INTRO]
for _, d in SHOTS:
    CUTS.append(CUTS[-1] + d)          # 3.5, 8, 12, 16, 20.5, 24.5, 28.5
TOTAL = CUTS[-1] + END                # 31.5 s
NFRAMES = round(TOTAL * FPS)

# intro layout (pixels in the 1080x1920 frame); set from the globe render's clear band
EMBLEM_CY, EMBLEM_SIZE = 304, 190


def ease_out(x):
    x = min(1, max(0, x)); return 1 - (1 - x) ** 3


def ramp(t, a, b):
    return min(1, max(0, (t - a) / (b - a))) if b > a else float(t >= a)


def load(path, mode='RGBA'):
    return Image.open(path).convert(mode)


def seq(dirpath, prefix='frame_'):
    if not os.path.isdir(dirpath):
        return []
    return sorted(os.path.join(dirpath, f) for f in os.listdir(dirpath) if f.startswith(prefix) and f.endswith('.png'))


def push(img, scale, cx=0.5, cy=0.5):
    """Zoom into img by `scale` (>=1) around (cx, cy) and return a WxH frame."""
    if scale <= 1.0001:
        return img.resize((W, H), Image.LANCZOS) if img.size != (W, H) else img
    w, h = img.size
    cw, ch = w / scale, h / scale
    x0 = min(max(cx * w - cw / 2, 0), w - cw); y0 = min(max(cy * h - ch / 2, 0), h - ch)
    return img.resize((W, H), Image.LANCZOS, box=(x0, y0, x0 + cw, y0 + ch))


def with_alpha(img, a):
    if a >= 0.999:
        return img
    r, g, b, al = img.split()
    return Image.merge('RGBA', (r, g, b, al.point(lambda v: int(v * a))))


def place(canvas, layer, x, y, alpha=1.0):
    if alpha <= 0.001:
        return
    canvas.alpha_composite(with_alpha(layer, alpha), (int(round(x)), int(round(y))))


_rng = np.random.default_rng(11)


def grain(img, amount=0.03):
    a = np.asarray(img.convert('RGB'), dtype=np.int16)
    n = _rng.normal(0, 255 * amount, a.shape[:2])[..., None]
    return Image.fromarray(np.clip(a + n, 0, 255).astype(np.uint8), 'RGB').convert('RGBA')


def darken(img, k):
    return ImageEnhance.Brightness(img).enhance(k)


class Assets:
    def __init__(self, work):
        self.work = work
        self.globe = seq(os.path.join(work, 'anim', 'globe'))
        self.emblem = seq(os.path.join(work, 'anim', 'emblem'))
        self.globe_end = os.path.join(work, 'anim', 'globe_end.png')
        self.shots = {sid: seq(os.path.join(work, 'footage', sid)) for sid, _ in SHOTS}
        cards = os.path.join(work, 'cards')
        self.caps = {sid: os.path.join(cards, f'cap_{sid}.png') for sid, _ in SHOTS}
        self.intro_card = os.path.join(cards, 'intro_lockup.png')
        self.end_card = os.path.join(cards, 'end_card.png')
        self._cache = {}

    def img(self, path):
        if path not in self._cache:
            self._cache[path] = load(path) if path and os.path.exists(path) else None
        return self._cache[path]


def frame_at(A, f):
    t = f / FPS
    canvas = Image.new('RGBA', (W, H), (4, 6, 10, 255))

    if t < INTRO:  # ---------------------------------------------------------------- intro
        if A.globe:
            g = load(A.globe[min(f, len(A.globe) - 1)])
            g = push(g, 1.0 + 0.04 * ease_out(t / INTRO), 0.5, 0.75)
            canvas.alpha_composite(g)
        canvas = grain(canvas, 0.025)
        if A.emblem:
            e = load(A.emblem[f % len(A.emblem)])
            k = 0.86 + 0.14 * ease_out(ramp(t, 0.15, 0.9))
            size = int(EMBLEM_SIZE * k)
            e = e.resize((size, size), Image.LANCZOS)
            place(canvas, e, W / 2 - size / 2, EMBLEM_CY - size / 2, ease_out(ramp(t, 0.15, 0.7)))
        card = A.img(A.intro_card)
        if card is not None:
            a = ease_out(ramp(t, 0.55, 1.15))
            place(canvas, card, 0, 26 * (1 - a), a)
        fade_in = ramp(t, 0, 0.4)
        if fade_in < 1:
            canvas = Image.blend(Image.new('RGBA', (W, H), (4, 6, 10, 255)), canvas, fade_in)
        return canvas

    if t < CUTS[-1]:  # ------------------------------------------------------------ map shots
        i = max(k for k in range(len(SHOTS)) if t >= CUTS[k])
        sid, dur = SHOTS[i]
        local = f - round(CUTS[i] * FPS)
        frames = A.shots[sid]
        if frames:
            canvas.alpha_composite(load(frames[min(local, len(frames) - 1)]))
        cap = A.img(A.caps[sid])
        if cap is not None:
            lt = local / FPS
            a_in = ease_out(ramp(lt, 0.10, 0.40))
            a_out = 1 - ramp(lt, dur - 0.22, dur - 0.02)
            place(canvas, cap, 0, 24 * (1 - a_in), min(a_in, a_out))
        if local < 4:  # cut flash
            canvas = ImageEnhance.Brightness(canvas).enhance(1 + [0.30, 0.16, 0.07, 0.02][local])
        return canvas

    # -------------------------------------------------------------------------------- end card
    lt = t - CUTS[-1]
    bg = A.img(A.globe_end)
    if bg is None and A.globe:
        bg = load(A.globe[-1])
    if bg is not None:
        b = push(bg, 1.06 + 0.03 * ease_out(lt / END), 0.5, 0.62)
        canvas.alpha_composite(darken(b.filter(ImageFilter.GaussianBlur(3)), 0.42))
    canvas = grain(canvas, 0.025)
    card = A.img(A.end_card)
    if card is not None:
        a = ease_out(ramp(lt, 0.05, 0.45))
        place(canvas, card, 0, 20 * (1 - a), a)
    fade_out = 1 - ramp(lt, END - 0.5, END - 0.02)
    if fade_out < 1:
        canvas = Image.blend(Image.new('RGBA', (W, H), (4, 6, 10, 255)), canvas, fade_out)
    if lt < 4 / FPS:
        canvas = ImageEnhance.Brightness(canvas).enhance(1 + [0.30, 0.16, 0.07, 0.02][int(lt * FPS)])
    return canvas


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--work', default=DEFAULT_WORK)
    ap.add_argument('--only', default='', help='frame range a-b (0-based, inclusive)')
    ap.add_argument('--preview', action='store_true', help='write a contact sheet of key frames instead')
    a = ap.parse_args()
    A = Assets(a.work)
    out = os.path.join(a.work, 'final'); os.makedirs(out, exist_ok=True)
    missing = [k for k, v in {'globe anim': A.globe, 'emblem anim': A.emblem}.items() if not v]
    missing += [p for p in [A.intro_card, A.end_card, *A.caps.values()] if not os.path.exists(p)]
    missing += [sid for sid, fr in A.shots.items() if not fr]
    print('timeline', [round(c, 2) for c in CUTS], 'total', TOTAL, 's', NFRAMES, 'frames; missing:', missing or 'none')
    if a.preview:
        keys = [10, 45, 100, 110, 160, 250, 380, 500, 640, 760, 870, 930]
        thumbs = [frame_at(A, k).convert('RGB').resize((270, 480), Image.LANCZOS) for k in keys]
        sheet = Image.new('RGB', (6 * 270, 2 * 480))
        for i, th in enumerate(thumbs):
            sheet.paste(th, ((i % 6) * 270, (i // 6) * 480))
        p = os.path.join(a.work, 'peek_edit.png'); sheet.save(p); print('preview', p)
    else:
        lo, hi = (int(x) for x in a.only.split('-')) if a.only else (0, NFRAMES - 1)
        for f in range(lo, hi + 1):
            frame_at(A, f).convert('RGB').save(os.path.join(out, f'frame_{f + 1:04d}.jpg'), quality=95, subsampling=0)
            if f % 100 == 0:
                print('frame', f + 1)
        json.dump({'fps': FPS, 'frames': NFRAMES, 'cuts': CUTS, 'total': TOTAL}, open(os.path.join(out, 'timeline.json'), 'w'))
        print('done', hi - lo + 1, 'frames ->', out)
