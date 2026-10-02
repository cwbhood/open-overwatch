"""Open Overwatch - final night-side ops globe (Blender 5.2, headless Cycles, emission only).

Run (Git Bash):
  "$LOCALAPPDATA/Microsoft/WindowsApps/blender-launcher.exe" -b --factory-startup --python brand/tools/globe.py -- \
      [--do stills,anim] [--variants wide,tall] [--tex DIR] [--out DIR] [--anim-out DIR] [--frames 1,60,120]
      [--samples 64] [--anim-samples 24] [--save-blend [PATH]] [--set key=value | --set tall:key=value ...]
  --do stills  renders hero-wide (2560x1600) and hero-tall (1080x1920) as .png/.jpg/.webp into --out (brand/hero)
  --do anim    renders the 1080x1920 30 fps intro, frame_0001.png ... frame_0120.png, into --anim-out (one process,
               render(animation=True)) and copies the last frame to <anim-out>/../globe_end.png;
               --frames 1,60,120 renders only those frames (spot check) as check_####.png
  --tex        folder with make_textures.py output (*_8k.png) + lights_haze_{1k,2k}.png (built here if missing)
  The log goes to <work>/globe.log (or brand/blend/globe.log) unless --log PATH is given.
  Haze maps only (system python with numpy + Pillow):  python globe.py --make-haze --tex DIR

Scenes: 'globe_wide' (start-screen background, composed on a 1920x1080 reference and rendered at 2560x1600 with
extra Earth below) and 'globe_tall' (TikTok intro/cover, animated over frames 1-120; frame 120 = the cover still).
Every surface is an emission shader (no lights, no bounces). Lines/rings are additive (emission + transparent).

Geography: lat/lon from the Earth's object-space position (lon = atan2(y, x), lat = asin(z)); equirectangular
textures map with u = lon/2pi + 0.5, v = lat/pi + 0.5. Rings and the tick ring are placed relative to the camera.
"""
import sys, os, math, time, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
BRAND = os.path.dirname(HERE)
WORK = os.environ.get('OW_WORK') or os.path.join(os.environ.get('LOCALAPPDATA', os.path.expanduser('~')), 'open-overwatch-brand')
DEF_TEX = os.path.join(BRAND, 'textures')
DEF_OUT = os.path.join(BRAND, 'hero')
DEF_ANIM = os.path.join(WORK, 'anim', 'globe')
DEF_BLEND = os.path.join(BRAND, 'blend', 'globe.blend')


# ------------------------------------------------------------------ haze maps (system python: numpy + Pillow)
def make_haze(tex):
    """lights_haze_2k (2048x1024, box 4 + blur 1.5 px) and lights_haze_1k (1024x512, box 8 + blur 2.5 px), 16-bit,
    normalised to max 1, blur wraps in longitude."""
    import numpy as np
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None
    a = np.asarray(Image.open(os.path.join(tex, 'lights_8k.png'))).astype(np.float32) / 65535.0

    def box(a, f):
        h, w = a.shape
        return a.reshape(h // f, f, w // f, f).mean(axis=(1, 3))

    def gblur(a, sigma):
        r = int(3 * sigma + 1); x = np.arange(-r, r + 1); k = np.exp(-0.5 * (x / sigma) ** 2); k /= k.sum()
        out = sum(kv * np.roll(a, i - r, axis=1) for i, kv in enumerate(k))
        pad = np.pad(out, ((r, r), (0, 0)), mode='edge')
        return sum(kv * pad[i:i + a.shape[0]] for i, kv in enumerate(k))

    for name, f, sig in (('lights_haze_2k.png', 4, 1.5), ('lights_haze_1k.png', 8, 2.5)):
        b = gblur(box(a, f), sig)
        b = b / max(b.max(), 1e-6)
        Image.fromarray(np.clip(b * 65535 + 0.5, 0, 65535).astype(np.uint16)).save(os.path.join(tex, name))


def encode(png):
    """<name>.png -> <name>.jpg (q85, RGB-mode JPEG so the sky stays exactly #04060a; a YCbCr JPEG rounds it to
    (5,6,10)) and <name>.webp (q82)."""
    from PIL import Image
    im = Image.open(png).convert('RGB')
    base = os.path.splitext(png)[0]
    im.save(base + '.jpg', quality=85, keep_rgb=True, subsampling=0, optimize=True)
    im.save(base + '.webp', quality=82, method=6)


try:
    import bpy, bmesh
    from mathutils import Vector, Quaternion
except ImportError:          # system python: haze builder and JPEG/WebP encoder
    if __name__ == '__main__':
        a = sys.argv
        if '--encode' in a:
            for png in a[a.index('--encode') + 1:]:
                encode(png)
                print('encoded', png)
        else:
            make_haze(a[a.index('--tex') + 1] if '--tex' in a else DEF_TEX)
            print('haze maps written')
    sys.exit(0)

sys.path.insert(0, HERE)
import bl_common as B

# ----------------------------------------------------------------------------------------------- config
CITIES = {
    'JFK': (40.64, -73.78), 'LHR': (51.47, -0.45), 'MAD': (40.47, -3.56), 'LIS': (38.77, -9.13),
    'MIA': (25.80, -80.29), 'GRU': (-23.43, -46.47), 'YYZ': (43.68, -79.63), 'KEF': (63.99, -22.62),
    'YVR': (49.19, -123.18), 'FRA': (50.04, 8.56), 'ORD': (41.98, -87.90), 'BOG': (4.70, -74.15),
    'DOV': (39.13, -75.47),  # Dover AFB (Delaware)
    'LKH': (52.41, 0.56),    # RAF Lakenheath (UK)
    'THU': (76.53, -68.70),  # Pituffik Space Base (Greenland)
    'LAJ': (38.76, -27.09),  # Lajes Field (Azores)
}
BG = '#04060a'

BASE = dict(
    # look (unchanged from concept A)
    ocean='#03060b', land='#08101a', land_lift=1.0,
    coast_gain=0.10, coast_col='#7dffa6', border_gain=0.035, border_col='#5fd3ff', grid_gain=0.030, grid_col='#5f7f9f',
    lights_gain=3.0, lights_pow=1.2, core_mix_lo=0.30, core_mix_hi=0.95, core_cool='#bff3ff', core_warm='#ffe9c4',
    haze_col='#7dffa6', haze2_gain=0.90, haze1_gain=0.18, limb_dark=0.65,
    day_gain=1.6, day_lo=0.30, day_hi=0.75, day_ocean='#0d2a44', day_land='#14302c',
    shell_r=1.09, airglow_r=1.012, airglow_w=0.0026, airglow_gain=0.50, airglow_col='#7dffa6',
    scat_gain=0.22, scat_h=0.008, scat_in=0.012, scat_col='#5fd3ff', sun_cam=(0.8, 0.3, -0.5), sun_bias=0.10,
    halo_gain=0.05, halo_h=0.035, halo_col='#5fd3ff',
    dawn=0.0, dawn_ang=45.0, dawn_spread=24.0,          # dawn crescent on the limb (0 = off)
    star_scale=170.0, star_keep=0.09, star_r=0.075, star_gain=0.30,
    # lines; every *_px is in reference pixels at the globe's distance (multiplied by px_scale)
    px_scale=1.0,
    ring_px=0.75, ring_col='#d9ccff', ring_alpha=0.30, ring_trail_px=70.0, ring_trail_gain=1.6,
    sat_px=2.0, sat_gain=3.5, sat_speed=0.012,
    arc_px=1.35, arc_base=0.10, arc_ahead=0.05, arc_fade=0.35, arc_gain=2.0, arc_h0=0.012, arc_hk=0.075, arc_hmax=0.075,
    plane_px=3.6, plane_gain=5.0, plane_hot=7.0, plane_hot_lo=0.80, plane_hot_hi=0.97,
    marker_r_px=4.5, marker_w_px=1.5, marker_gain=1.0,
    tick_ring=False, tick_r=1.04, tick_w_px=1.5, tick_col='#7dffa6', tick_alpha=0.55, tick_n=36, tick_len_px=7.0,
    tick_card_px=15.0,
    mask_rects=[], mask_feather=60.0,                   # ring gaps, in reference px
    # post
    glare_threshold=0.55, glare_strength=0.55, glare_size=0.55, glare_type='Fog Glow',
    glare2_strength=0.25, glare2_size=0.9, vignette=0.0, vig_r0=0.55, vig_r1=1.45,
    # animation (tall)
    anim=False, frames=120, fps=30, spin_deg=8.0, arc_t0=0.20, arc_dt=0.25, arc_draw=1.6, arc_drift=0.010,
)

PXS = 2560 / 1920   # the wide still is the 1920x1080 composition at 4/3 scale, plus 160 px more Earth below
VARIANTS = {
    'wide': dict(
        W=2560, H=1600, px_scale=PXS, target=(17.0, -50.0), d=4.2, R_px=880 * PXS, cx=960 * PXS,
        cy=1671.2 * PXS, roll=0.0,
        rings=[  # radius, tilt (deg, 0 = edge-on), roll in image (deg), satellite positions (0..1), direction
            (1.18, 62.0, -9.0, [], -1.0),
            (1.36, 70.0, 7.0, [0.10], 1.0),
            (1.85, 78.0, -3.0, [0.33], -1.0),
        ],
        arcs=[  # from, to, color, head position (0..1)[, height scale]
            ('JFK', 'LHR', '#5fd3ff', 0.66), ('YYZ', 'KEF', '#5fd3ff', 0.56), ('LHR', 'YVR', '#5fd3ff', 0.42, 0.4),
            ('LKH', 'THU', '#ffb44d', 0.55, 0.6),
        ],
        mask_rects=[(640, 365, 1280, 715)],   # splash block (1920x1080 reference px)
    ),
    'tall': dict(
        W=1080, H=1920, target=(14.0, -36.0), d=3.6, R_px=510, cx=540, cy=1160, roll=-12.0,
        sun_cam=(0.62, 0.66, -0.42), dawn=1.0, tick_ring=True, anim=True,
        rings=[(1.12, -7.0, -55.0, [0.835, 0.600], 1.0)],
        arcs=[
            ('JFK', 'LHR', '#5fd3ff', 0.66), ('YYZ', 'KEF', '#5fd3ff', 0.50), ('DOV', 'LAJ', '#ffb44d', 0.56),
            ('MAD', 'MIA', '#5fd3ff', 0.30), ('LIS', 'GRU', '#5fd3ff', 0.50),
        ],
    ),
}


def lin3(h):
    return tuple(B.hex_rgba(h)[:3])


def s2l(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def over_bg(hexcol, alpha):
    """Linear emission to ADD over the #04060a sky so the result equals an sRGB alpha blend (CSS opacity)."""
    fg = [int(hexcol[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    bg = [int(BG[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(max(0.0, s2l(bg[k] + (fg[k] - bg[k]) * alpha) - s2l(bg[k])) for k in range(3))


def ll(lat, lon, r=1.0):
    la, lo = math.radians(lat), math.radians(lon)
    return Vector((math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la))) * r


def ease_out(p):
    p = min(1.0, max(0.0, p))
    return 1 - (1 - p) ** 3


# ------------------------------------------------------------------------------------------ node helper
class NB:
    """Tiny shader-graph builder: every helper returns an output socket; args may be sockets or constants."""

    def __init__(self, nt):
        self.nt = nt

    def node(self, typ, **props):
        n = self.nt.nodes.new(typ)
        for k, v in props.items():
            setattr(n, k, v)
        return n

    def put(self, sock, v):
        if v is None:
            return
        if isinstance(v, bpy.types.NodeSocket):
            self.nt.links.new(v, sock)
        elif isinstance(v, (tuple, list)):
            n = len(sock.default_value)
            sock.default_value = (tuple(v) + (1.0,) * 4)[:n]
        else:
            sock.default_value = v

    def m(self, op, a, b=None, c=None, clamp=False):
        n = self.node('ShaderNodeMath', operation=op, use_clamp=clamp)
        self.put(n.inputs[0], a); self.put(n.inputs[1], b); self.put(n.inputs[2], c)
        return n.outputs[0]

    def v(self, op, a, b=None, s=None):
        n = self.node('ShaderNodeVectorMath', operation=op)
        self.put(n.inputs[0], a); self.put(n.inputs[1], b)
        if s is not None:
            self.put(n.inputs[3], s)
        return n.outputs[1] if op in ('DOT_PRODUCT', 'LENGTH', 'DISTANCE') else n.outputs[0]

    def smooth(self, x, e0, e1):
        n = self.node('ShaderNodeMapRange', data_type='FLOAT', interpolation_type='SMOOTHSTEP', clamp=True)
        self.put(n.inputs[0], x)
        self.put(n.inputs[1], e0); self.put(n.inputs[2], e1)
        n.inputs[3].default_value, n.inputs[4].default_value = 0.0, 1.0
        return n.outputs[0]

    def gauss(self, x, mu, w):
        z = self.m('DIVIDE', self.m('SUBTRACT', x, mu), w)
        return self.m('EXPONENT', self.m('MULTIPLY', self.m('MULTIPLY', z, z), -1.0))

    def scale(self, vec, s):
        return self.v('SCALE', vec, None, s)

    def add(self, *xs):
        out = xs[0]
        for x in xs[1:]:
            out = self.v('ADD', out, x)
        return out

    def mix(self, a, b, f):
        return self.add(a, self.scale(self.v('SUBTRACT', b, a), f))

    def value(self, name, val):
        n = self.node('ShaderNodeValue', name=name, label=name)
        n.outputs[0].default_value = val
        return n.outputs[0]

    def attr(self, name):
        return self.node('ShaderNodeAttribute', attribute_name=name).outputs['Fac']

    def emit_out(self, col, transparent=False):
        em = self.node('ShaderNodeEmission')
        self.put(em.inputs['Color'], col)
        em.inputs['Strength'].default_value = 1.0
        out = self.node('ShaderNodeOutputMaterial')
        if transparent:   # additive: light is added over whatever is behind
            tr = self.node('ShaderNodeBsdfTransparent')
            add = self.node('ShaderNodeAddShader')
            self.nt.links.new(em.outputs[0], add.inputs[0])
            self.nt.links.new(tr.outputs[0], add.inputs[1])
            self.nt.links.new(add.outputs[0], out.inputs['Surface'])
        else:
            self.nt.links.new(em.outputs[0], out.inputs['Surface'])


def new_material(name):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    m.node_tree.nodes.clear()
    try:
        m.cycles.emission_sampling = 'NONE'   # nothing here is lit, so emitters need no light sampling
    except Exception as e:
        B.log('emission_sampling not set:', e)
    return m, NB(m.node_tree)


_IMG = {}


def image(path):
    if path not in _IMG:
        img = bpy.data.images.load(path, check_existing=True)
        img.colorspace_settings.name = 'Non-Color'
        _IMG[path] = img
    return _IMG[path]


def tex(nb, uv, path, interp='Linear'):
    n = nb.node('ShaderNodeTexImage', interpolation=interp, extension='EXTEND')
    n.image = image(path)
    nb.put(n.inputs['Vector'], uv)
    return n.outputs['Color']


# ------------------------------------------------------------------------------------------- materials
def earth_material(c, name):
    m, nb = new_material(name)
    T = c['tex']
    tc = nb.node('ShaderNodeTexCoord')
    p = nb.v('NORMALIZE', tc.outputs['Object'])
    sep = nb.node('ShaderNodeSeparateXYZ'); nb.put(sep.inputs[0], p)
    lon = nb.m('ARCTAN2', sep.outputs['Y'], sep.outputs['X'])
    lat = nb.m('ARCSINE', sep.outputs['Z'])
    u = nb.m('MULTIPLY_ADD', lon, 1 / (2 * math.pi), 0.5)
    v = nb.m('MULTIPLY_ADD', lat, 1 / math.pi, 0.5)
    uvn = nb.node('ShaderNodeCombineXYZ'); nb.put(uvn.inputs[0], u); nb.put(uvn.inputs[1], v)
    uv = uvn.outputs[0]

    land = tex(nb, uv, os.path.join(T, 'land_8k.png'))
    coast = tex(nb, uv, os.path.join(T, 'coast_8k.png'))
    border = tex(nb, uv, os.path.join(T, 'borders_8k.png'))
    grid = tex(nb, uv, os.path.join(T, 'grid_8k.png'))
    L = tex(nb, uv, os.path.join(T, 'lights_8k.png'))
    h2 = tex(nb, uv, os.path.join(T, 'lights_haze_2k.png'), 'Cubic')
    h1 = tex(nb, uv, os.path.join(T, 'lights_haze_1k.png'), 'Cubic')

    base = nb.mix(lin3(c['ocean']), nb.scale(lin3(c['land']), c['land_lift']), land)
    coast_c = nb.scale(lin3(c['coast_col']), nb.m('MULTIPLY', coast, c['coast_gain']))
    border_c = nb.scale(lin3(c['border_col']), nb.m('MULTIPLY', border, c['border_gain']))
    grid_c = nb.scale(lin3(c['grid_col']), nb.m('MULTIPLY', grid, c['grid_gain']))
    core_col = nb.mix(lin3(c['core_cool']), lin3(c['core_warm']), nb.smooth(L, c['core_mix_lo'], c['core_mix_hi']))
    core = nb.scale(core_col, nb.m('MULTIPLY', nb.m('POWER', L, c['lights_pow']), c['lights_gain']))
    haze_amt = nb.m('ADD', nb.m('MULTIPLY', h2, c['haze2_gain']), nb.m('MULTIPLY', h1, c['haze1_gain']))
    haze = nb.scale(lin3(c['haze_col']), haze_amt)
    col = nb.add(base, coast_c, border_c, grid_c, haze, core)
    if c['day_gain'] > 0:   # thin sunlit sliver on the limb that faces the hidden sun (world space: stays put)
        geo0 = nb.node('ShaderNodeNewGeometry')
        sdot = nb.v('DOT_PRODUCT', nb.v('NORMALIZE', geo0.outputs['Position']), c['sun_dir'])
        day = nb.m('MULTIPLY', nb.smooth(sdot, c['day_lo'], c['day_hi']), c['day_gain'])
        col = nb.add(col, nb.scale(nb.mix(lin3(c['day_ocean']), lin3(c['day_land']), land), day))
    geo = nb.node('ShaderNodeNewGeometry')
    b = nb.v('LENGTH', nb.v('CROSS_PRODUCT', geo.outputs['Position'], nb.v('NORMALIZE', geo.outputs['Incoming'])))
    f = nb.m('SUBTRACT', 1.0, nb.m('MULTIPLY', nb.smooth(b, 0.70, 1.0), c['limb_dark']))
    nb.emit_out(nb.scale(col, f))
    return m


def shell_material(c, name):
    """Additive shell: green airglow line above the limb, cyan scattering haze, optional dawn crescent."""
    m, nb = new_material(name)
    geo = nb.node('ShaderNodeNewGeometry')
    pos = geo.outputs['Position']
    b = nb.v('LENGTH', nb.v('CROSS_PRODUCT', pos, nb.v('NORMALIZE', geo.outputs['Incoming'])))
    ag = nb.gauss(b, c['airglow_r'], c['airglow_w'])
    outside = nb.m('GREATER_THAN', b, 1.0)
    s_out = nb.m('EXPONENT', nb.m('DIVIDE', nb.m('SUBTRACT', 1.0, b), c['scat_h']))
    s_in = nb.m('MULTIPLY', nb.m('EXPONENT', nb.m('DIVIDE', nb.m('SUBTRACT', b, 1.0), c['scat_in'])), 0.55)
    sc = nb.m('ADD', nb.m('MULTIPLY', outside, s_out), nb.m('MULTIPLY', nb.m('SUBTRACT', 1.0, outside), s_in))
    halo = nb.m('MULTIPLY', outside, nb.m('EXPONENT', nb.m('DIVIDE', nb.m('SUBTRACT', 1.0, b), c['halo_h'])))
    edge = nb.m('SUBTRACT', 1.0, nb.smooth(b, c['shell_r'] - 0.03, c['shell_r'] - 0.001))
    sd = Vector(c['sun_dir']).normalized()
    dirf = nb.m('MULTIPLY_ADD', nb.smooth(nb.v('DOT_PRODUCT', nb.v('NORMALIZE', pos), tuple(sd)), -0.5, 1.0),
                1.0 - c['sun_bias'], c['sun_bias'])
    col = nb.add(nb.scale(lin3(c['airglow_col']), nb.m('MULTIPLY', ag, c['airglow_gain'])),
                 nb.scale(lin3(c['scat_col']), nb.m('MULTIPLY', sc, c['scat_gain'])),
                 nb.scale(lin3(c['halo_col']), nb.m('MULTIPLY', halo, c['halo_gain'])))
    col = nb.scale(col, nb.m('MULTIPLY', edge, dirf))
    if c['dawn'] > 0:
        # position angle in the image (0 = up, +90 = right), from the camera's right/up axes
        ang = nb.m('ARCTAN2', nb.v('DOT_PRODUCT', pos, tuple(c['cam_right'])), nb.v('DOT_PRODUCT', pos, tuple(c['cam_up'])))
        w = nb.gauss(ang, math.radians(c['dawn_ang']), math.radians(c['dawn_spread']))
        amber = nb.scale(lin3('#ffb44d'), nb.m('MULTIPLY', nb.gauss(b, 1.0010, 0.0024), 0.42))
        warm = nb.scale(lin3('#ffe9c4'), nb.m('MULTIPLY', nb.gauss(b, 1.0045, 0.0026), 0.20))
        cyan = nb.scale(lin3('#5fd3ff'), nb.m('MULTIPLY', nb.gauss(b, 1.0105, 0.0065), 0.16))
        col = nb.add(col, nb.scale(nb.add(amber, warm, cyan), nb.m('MULTIPLY', w, c['dawn'])))
    nb.emit_out(col, transparent=True)
    return m


def ring_material(name, c, sats, sign, trail):
    """Orbit ring: uniform #d9ccff line at ring_alpha (sRGB blend over the sky) plus short satellite trails;
    the per-vertex attribute 'vis' (0..1) gaps the ring behind UI blocks."""
    m, nb = new_material(name)
    t = nb.attr('t')
    head = nb.value('sat_t', sats[0] if sats else 0.0)
    total = None
    for i, h in enumerate(sats):
        hv = head if i == 0 else nb.m('ADD', head, h - sats[0])
        d = nb.m('FRACT', nb.m('MULTIPLY', nb.m('SUBTRACT', hv, t), sign))
        tr = nb.m('EXPONENT', nb.m('DIVIDE', d, -trail))
        total = tr if total is None else nb.m('MAXIMUM', total, tr)
    colv = over_bg(c['ring_col'], c['ring_alpha'])
    if total is not None:
        colv = nb.add(colv, nb.scale(lin3(c['ring_col']), nb.m('MULTIPLY', total, c['ring_trail_gain'])))
    nb.emit_out(nb.scale(colv, nb.attr('vis')), transparent=True)
    return m


def arc_material(name, c, col, head0):
    """Flight arc drawn from t=0 to head_t; the drawn part ramps up over its last arc_fade of length; the route
    ahead of the head is a faint line scaled by route_on (0..1)."""
    m, nb = new_material(name)
    t = nb.attr('t')
    head = nb.value('head_t', head0)
    on = nb.value('route_on', 1.0)
    drawn = nb.m('GREATER_THAN', nb.m('SUBTRACT', head, t), -0.0005)
    s = nb.m('DIVIDE', t, nb.m('MAXIMUM', head, 0.001))
    ramp = nb.smooth(s, 1.0 - c['arc_fade'], 1.0)
    inten = nb.m('ADD', nb.m('MULTIPLY', drawn, nb.m('MULTIPLY_ADD', ramp, c['arc_gain'], c['arc_base'])),
                 nb.m('MULTIPLY', nb.m('SUBTRACT', 1.0, drawn), nb.m('MULTIPLY', on, c['arc_ahead'])))
    nb.emit_out(nb.scale(lin3(col), inten), transparent=True)
    return m


def plane_material(name, c, col):
    """Aircraft head: core in the arc colour with a small white-hot centre (by facing ratio)."""
    m, nb = new_material(name)
    geo = nb.node('ShaderNodeNewGeometry')
    facing = nb.v('DOT_PRODUCT', geo.outputs['Normal'], geo.outputs['Incoming'])
    hot = nb.smooth(facing, c['plane_hot_lo'], c['plane_hot_hi'])
    core = tuple(x * c['plane_gain'] for x in lin3(col))
    white = (c['plane_hot'],) * 3
    nb.emit_out(nb.mix(core, white, hot))
    return m


def add_material(name, rgb, onval=None):
    """Additive flat emission; optional animatable Value 'on' multiplier."""
    m, nb = new_material(name)
    colv = rgb
    if onval is not None:
        colv = nb.scale(rgb, nb.value('on', onval))
    nb.emit_out(colv, transparent=True)
    return m


def flat_emission(name, hexcol, strength):
    m, nb = new_material(name)
    nb.emit_out(tuple(x * strength for x in lin3(hexcol)))
    return m


# -------------------------------------------------------------------------------------------- geometry
def link(ob, coll, parent=None):
    coll.objects.link(ob)
    if parent:
        ob.parent = parent
    return ob


def sphere_obj(name, r, seg, rings, mat, coll, loc=(0, 0, 0), parent=None):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=r)
    bm.to_mesh(me); bm.free()
    me.shade_smooth()
    me.materials.append(mat)
    ob = link(bpy.data.objects.new(name, me), coll, parent)
    ob.location = loc
    return ob


def tube_obj(name, fn, n, radius, mat, coll, sides=6, parent=None, vis=None):
    """Tube along fn(t), t in [0,1]; vertex attributes 't' (line parameter) and 'vis' (vis(t), default 1)."""
    verts, faces, tv, vv = [], [], [], []
    eps = 1e-4
    for i in range(n + 1):
        t = i / n
        p = fn(t)
        T = (fn(min(t + eps, 1.0)) - fn(max(t - eps, 0.0))).normalized()
        R = p.normalized()
        N = (R - T * R.dot(T)).normalized()
        Bv = T.cross(N)
        vis_t = vis(t) if vis else 1.0
        for k in range(sides):
            a = 2 * math.pi * k / sides
            verts.append(tuple(p + (N * math.cos(a) + Bv * math.sin(a)) * radius))
            tv.append(t); vv.append(vis_t)
    for i in range(n):
        for k in range(sides):
            k2 = (k + 1) % sides
            faces.append((i * sides + k, i * sides + k2, (i + 1) * sides + k2, (i + 1) * sides + k))
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    for an, data in (('t', tv), ('vis', vv)):
        at = me.attributes.new(an, 'FLOAT', 'POINT')
        at.data.foreach_set('value', data)
    me.shade_smooth()
    me.materials.append(mat)
    return link(bpy.data.objects.new(name, me), coll, parent)


def flat_obj(name, quads_2d, mat, coll, origin, ex, ey, parent=None):
    """Flat mesh from 2D quads (lists of 4 (x, y) points), placed in the plane origin + x*ex + y*ey."""
    verts, faces = [], []
    for q in quads_2d:
        i0 = len(verts)
        for x, y in q:
            verts.append(tuple(origin + ex * x + ey * y))
        faces.append(tuple(range(i0, i0 + 4)))
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    me.materials.append(mat)
    return link(bpy.data.objects.new(name, me), coll, parent)


def annulus(r0, r1, n=48):
    out = []
    for k in range(n):
        a0, a1 = 2 * math.pi * k / n, 2 * math.pi * (k + 1) / n
        out.append([(r0 * math.cos(a0), r0 * math.sin(a0)), (r1 * math.cos(a0), r1 * math.sin(a0)),
                    (r1 * math.cos(a1), r1 * math.sin(a1)), (r0 * math.cos(a1), r0 * math.sin(a1))])
    return out


def empty(name, coll):
    return link(bpy.data.objects.new(name, None), coll)


# ----------------------------------------------------------------------------------------- world/post
def world_stars(sc, c):
    w = bpy.data.worlds.new(sc.name + '_world')
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    nb = NB(nt)
    tc = nb.node('ShaderNodeTexCoord')
    vor = nb.node('ShaderNodeTexVoronoi', voronoi_dimensions='3D', feature='F1', distance='EUCLIDEAN')
    nb.put(vor.inputs['Vector'], tc.outputs['Generated'])
    vor.inputs['Scale'].default_value = c['star_scale']
    vor.inputs['Randomness'].default_value = 1.0
    rnd = nb.node('ShaderNodeSeparateXYZ'); nb.put(rnd.inputs[0], vor.outputs['Color'])
    keep = nb.m('GREATER_THAN', rnd.outputs['X'], 1.0 - c['star_keep'])
    dd = nb.m('DIVIDE', vor.outputs['Distance'], c['star_r'])
    core = nb.m('EXPONENT', nb.m('MULTIPLY', nb.m('MULTIPLY', dd, dd), -1.0))
    bright = nb.m('MULTIPLY_ADD', nb.m('POWER', rnd.outputs['Y'], 3.0), 0.85, 0.15)
    s = nb.m('MULTIPLY', nb.m('MULTIPLY', keep, core), nb.m('MULTIPLY', bright, c['star_gain']))
    scol = nb.mix(lin3('#8b9bab'), lin3('#d9e4f0'), rnd.outputs['Z'])
    col = nb.add(lin3(BG), nb.scale(scol, s))
    bg = nb.node('ShaderNodeBackground')
    nb.put(bg.inputs['Color'], col)
    bg.inputs['Strength'].default_value = 1.0
    out = nb.node('ShaderNodeOutputWorld')
    nt.links.new(bg.outputs[0], out.inputs['Surface'])
    try:
        w.cycles.sampling_method = 'NONE'
    except Exception as e:
        B.log('world sampling not set:', e)
    sc.world = w


def compositor(sc, c):
    ng = bpy.data.node_groups.new(sc.name + '_comp', 'CompositorNodeTree')
    ng.interface.new_socket(name='Image', in_out='OUTPUT', socket_type='NodeSocketColor')
    sc.compositing_node_group = ng
    sc.render.use_compositing = True
    nb = NB(ng)
    rl = nb.node('CompositorNodeRLayers')
    try:
        rl.scene = sc
    except Exception as e:
        B.log('rl.scene not set:', e)
    g1 = nb.node('CompositorNodeGlare')   # tight glow
    g1.inputs['Type'].default_value = c['glare_type']
    g1.inputs['Quality'].default_value = 'High'
    g1.inputs['Threshold'].default_value = c['glare_threshold']
    g1.inputs['Strength'].default_value = c['glare_strength']
    g1.inputs['Size'].default_value = c['glare_size']
    ng.links.new(rl.outputs['Image'], g1.inputs['Image'])
    g2 = nb.node('CompositorNodeGlare')   # wide, faint bloom
    g2.inputs['Type'].default_value = 'Bloom'
    g2.inputs['Quality'].default_value = 'Medium'
    g2.inputs['Threshold'].default_value = c['glare_threshold'] * 0.6
    g2.inputs['Strength'].default_value = c['glare2_strength']
    g2.inputs['Size'].default_value = c['glare2_size']
    ng.links.new(g1.outputs['Image'], g2.inputs['Image'])
    img = g2.outputs['Image']
    if c['vignette'] > 0:
        ic = nb.node('CompositorNodeImageCoordinates')
        ng.links.new(rl.outputs['Image'], ic.inputs['Image'])
        q = nb.v('MULTIPLY', nb.v('SUBTRACT', ic.outputs['Normalized'], (0.5, 0.5, 0.0)), (2.0, 2.0, 0.0))
        r = nb.v('LENGTH', q)
        vig = nb.m('SUBTRACT', 1.0, nb.m('MULTIPLY', nb.smooth(r, c['vig_r0'], c['vig_r1']), c['vignette']))
        img = nb.scale(img, vig)
    out = nb.node('NodeGroupOutput')
    ng.links.new(img, out.inputs[0])


# ----------------------------------------------------------------------------------------------- scene
def key(sock_or_ob, path, val, frame):
    if path == 'default_value':
        sock_or_ob.default_value = val
    else:
        setattr(sock_or_ob, path, val)
    sock_or_ob.keyframe_insert(path, frame=frame)


def mat_value(mat, name):
    return mat.node_tree.nodes[name].outputs[0]


def build_scene(sc, name, cfg, o):
    c = dict(BASE); c.update(cfg); c['tex'] = o['tex']
    W, H, k = c['W'], c['H'], c['px_scale']
    B.setup_cycles(sc, W, H, samples=o['samples'], denoise=False)
    sc.view_settings.view_transform = 'Standard'
    sc.view_settings.look = 'None'
    sc.render.dither_intensity = 0.0          # keeps the sky exactly #04060a
    cy = sc.cycles
    cy.max_bounces = 4; cy.diffuse_bounces = 0; cy.glossy_bounces = 0; cy.transmission_bounces = 0
    cy.volume_bounces = 0; cy.transparent_max_bounces = 32
    cy.adaptive_threshold = 0.004
    world_stars(sc, c)
    compositor(sc, c)
    coll = sc.collection

    # camera: a unit sphere at distance d projects to radius f*tan(asin(1/d)); lens shift places it
    Lmax = max(W, H)
    d = c['d']
    lens = 18.0 * c['R_px'] / ((Lmax / 2) * math.tan(math.asin(1.0 / d)))
    cd = bpy.data.cameras.new(name + '_cam')
    cd.lens, cd.sensor_width, cd.sensor_fit = lens, 36.0, 'AUTO'
    cd.shift_x = -(c['cx'] - W / 2) / Lmax
    cd.shift_y = (c['cy'] - H / 2) / Lmax
    cd.clip_start, cd.clip_end = 0.01, 100.0
    cam = bpy.data.objects.new(name + '_cam', cd)
    coll.objects.link(cam)
    p0 = ll(*c['target']) * d
    cam.location = p0
    q = (-p0).to_track_quat('-Z', 'Y') @ Quaternion((0, 0, 1), math.radians(c['roll']))
    cam.rotation_mode = 'QUATERNION'
    cam.rotation_quaternion = q
    sc.camera = cam
    from mathutils import Matrix
    cam.matrix_world = Matrix.Translation(p0) @ q.to_matrix().to_4x4()   # valid before any depsgraph update
    sc.view_layers[0].update()
    M = q.to_matrix()
    right, up, back = M.col[0], M.col[1], M.col[2]
    c['cam_right'], c['cam_up'] = tuple(right), tuple(up)
    px = 1.0 / c['R_px']          # world units per output pixel at the globe's distance (approx.)
    pxr = px * k                  # ... per reference pixel
    sc_ = Vector(c['sun_cam'])     # hidden sun, given in camera axes (right, up, toward camera)
    c['sun_dir'] = tuple((right * sc_.x + up * sc_.y + back * sc_.z).normalized())
    B.log(name, 'lens %.2f shift %.4f %.4f px-unit %.6f' % (lens, cd.shift_x, cd.shift_y, px))
    from bpy_extras.object_utils import world_to_camera_view

    def scr(p):   # output pixel coords (y down)
        v = world_to_camera_view(sc, cam, p)
        return v.x * W, (1 - v.y) * H

    def vis_at(p):   # 1 outside the mask rects, feathered to 0 inside them (reference px)
        if not c['mask_rects']:
            return 1.0
        x, y = scr(p)
        x, y = x / k, y / k
        f = c['mask_feather']
        v = 1.0
        for (x0, y0, x1, y1) in c['mask_rects']:
            dx = max(x0 - x, 0.0, x - x1); dy = max(y0 - y, 0.0, y - y1)
            dist = math.hypot(dx, dy)   # 0 inside the rect
            s = min(1.0, dist / f)
            v = min(v, s * s * (3 - 2 * s))
        return v

    rig = empty(name + '_EarthRig', coll)
    orbit = empty(name + '_OrbitRig', coll)
    sphere_obj(name + '_Earth', 1.0, 384, 192, earth_material(c, name + '_EarthNight'), coll, parent=rig)
    sphere_obj(name + '_Atmosphere', c['shell_r'], 256, 128, shell_material(c, name + '_Atmosphere'), coll)

    # ---- orbit rings (camera-relative): tilt opens the ellipse, roll turns it in the image
    anim = []   # (kind, data) collected for the animation pass
    for i, ring in enumerate(c['rings']):
        rad, tilt, rroll, sats = ring[:4]
        sign = ring[4] if len(ring) > 4 else 1.0
        tq = Quaternion(back, math.radians(rroll))
        n = (up * math.cos(math.radians(tilt)) + back * math.sin(math.radians(tilt))).normalized()
        n = tq @ n
        e1 = n.cross(back)
        e1 = e1.normalized() if e1.length > 1e-6 else (tq @ right)
        e2 = n.cross(e1).normalized()
        fn = (lambda e1, e2, rad: lambda t: (e1 * math.cos(2 * math.pi * t) + e2 * math.sin(2 * math.pi * t)) * rad)(e1, e2, rad)
        trail = c['ring_trail_px'] * pxr / (2 * math.pi * rad)
        mat = ring_material('%s_ring%d' % (name, i), c, sats, sign, trail)
        tube_obj('%s_Ring%d' % (name, i), fn, 1440, c['ring_px'] * pxr, mat, coll, parent=orbit,
                 vis=lambda t, fn=fn: vis_at(fn(t)))
        smat = flat_emission('%s_sat%d' % (name, i), '#d9ccff', c['sat_gain'])
        for j, st in enumerate(sats):
            ob = sphere_obj('%s_Sat%d_%d' % (name, i, j), c['sat_px'] * pxr, 16, 8, smat, coll, loc=fn(st), parent=orbit)
            anim.append(('sat', (ob, fn, st, sign, mat if j == 0 else None)))

    # ---- flight arcs: great circles lifted by h0 + hk * angular distance at mid-flight
    cam_dir = (cam.location).normalized()
    placed = set()
    for i, arc in enumerate(c['arcs']):
        a, b2, col, head = arc[:4]
        hscale = arc[4] if len(arc) > 4 else 1.0
        A, Bv = ll(*CITIES[a]), ll(*CITIES[b2])
        om = math.acos(max(-1.0, min(1.0, A.dot(Bv))))
        hgt = min(c['arc_hmax'], c['arc_h0'] + c['arc_hk'] * om) * hscale
        fn = (lambda A, Bv, om, hgt: lambda t: ((math.sin((1 - t) * om) * A + math.sin(t * om) * Bv) / math.sin(om))
              * (1.0015 + hgt * math.sin(math.pi * t)))(A, Bv, om, hgt)
        mat = arc_material('%s_arc%d' % (name, i), c, col, head)
        tube_obj('%s_Arc%d_%s_%s' % (name, i, a, b2), fn, 360, c['arc_px'] * pxr, mat, coll, parent=rig)
        pob = sphere_obj('%s_Plane%d' % (name, i), c['plane_px'] * pxr, 24, 12, plane_material('%s_plane%d' % (name, i), c, col),
                         coll, loc=fn(head), parent=rig)
        # ring markers (camera-facing annulus, outer radius marker_r_px, stroke marker_w_px)
        r1 = c['marker_r_px'] * pxr; r0 = r1 - c['marker_w_px'] * pxr
        mm = add_material('%s_marker%d' % (name, i), tuple(x * c['marker_gain'] for x in lin3(col)), 1.0)
        mks = []
        for city in (a, b2):
            if (city, col) in placed:      # shared endpoint (e.g. LHR on two cyan routes): one marker
                continue
            placed.add((city, col))
            pc = ll(*CITIES[city])
            sinth = math.sqrt(max(0.0, 1 - pc.dot(cam_dir) ** 2))
            lift = 1.0015 + r1 * sinth * 1.05
            mk = flat_obj('%s_Marker%d_%s' % (name, i, city), annulus(r0, r1), mm, coll, Vector((0, 0, 0)),
                          Vector((1, 0, 0)), Vector((0, 1, 0)), parent=rig)
            mk.location = ll(*CITIES[city], r=lift)
            con = mk.constraints.new('DAMPED_TRACK')
            con.target = cam; con.track_axis = 'TRACK_Z'
            mks.append(mk)
        anim.append(('arc', (i, mat, pob, fn, head, mm)))

    # ---- camera-facing tick ring (bezel echo)
    if c['tick_ring']:
        rw = c['tick_r'] * d / math.sqrt(d * d - 1)       # radius in the plane through the centre
        pc = rw / (c['tick_r'] * c['R_px'])                # world units per output pixel in that plane
        w = c['tick_w_px'] * k * pc / 2
        quads = annulus(rw - w, rw + w, 720)
        for j in range(c['tick_n']):
            a_ = 2 * math.pi * j / c['tick_n']
            card = (j * 360 // c['tick_n']) % 90 == 0
            ln = (c['tick_card_px'] if card else c['tick_len_px']) * k * pc
            ux, uy = math.sin(a_), math.cos(a_)           # 0 = up, clockwise
            tx, ty = uy, -ux
            r_in, r_out = rw + w * 0.5, rw + w + ln
            quads.append([(ux * r_in - tx * w, uy * r_in - ty * w), (ux * r_out - tx * w, uy * r_out - ty * w),
                          (ux * r_out + tx * w, uy * r_out + ty * w), (ux * r_in + tx * w, uy * r_in + ty * w)])
        tm = add_material(name + '_ticks', over_bg(c['tick_col'], c['tick_alpha']))
        flat_obj(name + '_TickRing', quads, tm, coll, Vector((0, 0, 0)), right, up)

    # ---- animation: Earth spin, staggered arc draw-on (ease-out) with travelling heads, satellites moving
    fps, F = c['fps'], c['frames']
    sc.render.fps = fps
    sc.frame_start, sc.frame_end = 1, F
    sc.frame_current = F
    if c['anim']:
        T = (F - 1) / fps     # seconds from frame 1 to the last frame (the still = last frame)
        for f in range(1, F + 1):
            tt = (f - 1) / fps
            rig.rotation_euler = (0, 0, math.radians(-c['spin_deg'] * (1 - tt / T)))
            rig.keyframe_insert('rotation_euler', frame=f)
            for kind, dat in anim:
                if kind == 'arc':
                    i, mat, pob, fn, head, mm = dat
                    s0 = c['arc_t0'] + c['arc_dt'] * i
                    h_draw = head - c['arc_drift'] * (T - s0)
                    h = h_draw * ease_out((tt - s0) / c['arc_draw']) + c['arc_drift'] * max(0.0, tt - s0)
                    h = max(0.0, min(head, h))
                    key(mat_value(mat, 'head_t'), 'default_value', h, f)
                    on = min(1.0, max(0.0, (tt - s0 + 0.05) / 0.30))
                    key(mat_value(mat, 'route_on'), 'default_value', on, f)
                    key(mat_value(mm, 'on'), 'default_value', on, f)
                    pob.location = fn(h); pob.keyframe_insert('location', frame=f)
                    sc_on = min(1.0, max(0.0, (tt - s0) * fps / 3.0))
                    pob.scale = (sc_on,) * 3; pob.keyframe_insert('scale', frame=f)
                else:
                    ob, fn, st, sign, mat = dat
                    u = st + sign * c['sat_speed'] * (tt - T)
                    ob.location = fn(u); ob.keyframe_insert('location', frame=f)
                    if mat is not None:
                        key(mat_value(mat, 'sat_t'), 'default_value', u, f)
        sc.frame_set(F)

    sc.view_layers[0].update()
    for ob in coll.objects:
        if '_Sat' in ob.name or '_Plane' in ob.name or '_Marker' in ob.name:
            x, y = scr(ob.matrix_world.translation)
            B.log('  %-30s px (%6.0f, %6.0f)' % (ob.name, x, y))
    return sc


# ---------------------------------------------------------------------------------------------- driver
def parse():
    a = B.script_args()
    o = dict(do='stills', variants='wide,tall', samples=64, anim_samples=24, tex=DEF_TEX, out=DEF_OUT,
             anim_out=DEF_ANIM, frames='', save_blend=None, sets=[], log=None, denoise=1)
    i = 0
    while i < len(a):
        k = a[i]
        if k == '--save-blend':      # optional path argument
            if i + 1 < len(a) and not a[i + 1].startswith('--'):
                o['save_blend'] = a[i + 1]; i += 1
            else:
                o['save_blend'] = DEF_BLEND
        elif k == '--set':
            o['sets'].append(a[i + 1]); i += 1
        else:
            o[k.lstrip('-').replace('-', '_')] = a[i + 1]; i += 1
        i += 1
    return o


def apply_sets(sets):
    for s in sets:
        k, v = s.split('=', 1)
        var = None
        if ':' in k:
            var, k = k.split(':', 1)
        try:
            val = eval(v, {})
        except Exception:
            val = v
        for name, cfg in VARIANTS.items():
            if var in (None, name):
                cfg[k] = val


def save_formats(sc, base):
    """<base>.png -> .jpg (q85) + .webp (q82): Pillow via system python, else Blender's own writers."""
    try:
        subprocess.run(['python', os.path.abspath(__file__), '--encode', base + '.png'], check=True)
        for ext in ('.jpg', '.webp'):
            B.log('wrote', base + ext, os.path.getsize(base + ext))
        return
    except Exception as e:
        B.log('Pillow encode failed, using Blender writers:', e)
    rr = bpy.data.images['Render Result']
    ims = sc.render.image_settings
    for fmt, ext, q in (('JPEG', '.jpg', 85), ('WEBP', '.webp', 82)):
        try:
            ims.file_format = fmt
            ims.color_mode = 'RGB'
            ims.quality = q
            rr.save_render(base + ext, scene=sc)
            B.log('wrote', base + ext, os.path.getsize(base + ext))
        except Exception as e:
            B.log('could not write', ext, e)
    ims.file_format = 'PNG'; ims.color_depth = '8'


def main():
    o = parse()
    apply_sets(o['sets'])
    for nm in ('lights_haze_2k.png', 'lights_haze_1k.png'):
        if not os.path.exists(os.path.join(o['tex'], nm)):
            B.log('building haze maps with system python')
            subprocess.run(['python', os.path.abspath(__file__), '--make-haze', '--tex', o['tex']], check=True)
            break
    B.clear_scene()
    first = bpy.context.scene
    scenes = {}
    # the animated tall scene must be the context scene: frame_set()/render(animation=True) only evaluate
    # keyframes for the active scene's depsgraph in background mode
    for i, name in enumerate(('tall', 'wide')):
        sc = first if i == 0 else bpy.data.scenes.new('globe_' + name)
        sc.name = 'globe_' + name
        scenes[name] = build_scene(sc, sc.name, VARIANTS[name], o)
    if o['save_blend']:
        os.makedirs(os.path.dirname(o['save_blend']), exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=o['save_blend'], compress=True)
        B.log('saved', o['save_blend'])
    todo = o['do'].split(',')
    if 'stills' in todo:
        os.makedirs(o['out'], exist_ok=True)
        for name in o['variants'].split(','):
            if not name:
                continue
            sc = scenes[name]
            sc.cycles.samples = int(o['samples'])
            sc.frame_set(sc.frame_end)
            base = os.path.join(o['out'], 'hero-' + name)
            sc.render.filepath = base + '.png'
            t0 = time.time()
            bpy.ops.render.render(write_still=True, scene=sc.name)
            B.log('render', name, '%dx%d %d spp: %.1f s' % (sc.render.resolution_x, sc.render.resolution_y,
                                                            sc.cycles.samples, time.time() - t0), base + '.png')
            save_formats(sc, base)
    if 'anim' in todo:
        sc = scenes['tall']
        sc.cycles.samples = int(o['anim_samples'])
        sc.cycles.use_denoising = bool(int(o['denoise']))
        if sc.cycles.use_denoising:
            sc.cycles.denoiser = 'OPENIMAGEDENOISE'
            try:
                sc.cycles.denoising_use_gpu = True
            except Exception:
                pass
            sc.cycles.denoising_input_passes = 'RGB_ALBEDO_NORMAL'
            sc.cycles.denoising_prefilter = 'ACCURATE'
        sc.cycles.seed = 0
        sc.cycles.use_animated_seed = False
        sc.render.use_persistent_data = True
        os.makedirs(o['anim_out'], exist_ok=True)
        if o['frames']:
            for f in [int(x) for x in o['frames'].split(',')]:
                sc.frame_set(f)
                sc.render.filepath = os.path.join(o['anim_out'], 'check_%04d.png' % f)
                t0 = time.time()
                bpy.ops.render.render(write_still=True, scene=sc.name)
                B.log('check frame', f, '%.1f s' % (time.time() - t0))
        else:
            sc.render.filepath = os.path.join(o['anim_out'], 'frame_####')
            t0 = time.time()
            bpy.ops.render.render(animation=True, scene=sc.name)
            dt = time.time() - t0
            B.log('animation %d frames: %.1f s (%.2f s/frame)' % (sc.frame_end, dt, dt / sc.frame_end))
            import shutil
            last = os.path.join(o['anim_out'], 'frame_%04d.png' % sc.frame_end)
            shutil.copyfile(last, os.path.join(os.path.dirname(o['anim_out']), 'globe_end.png'))


_a = B.script_args()
_log = _a[_a.index('--log') + 1] if '--log' in _a else os.path.join(WORK if os.path.isdir(WORK) else os.path.join(BRAND, 'blend'), 'globe.log')
B.run(main, _log)
