"""Open Overwatch emblem - the final 3D logo ("Radar Scope").

A 3D take on the app's CSS .mark: a dark slate bezel with 36 bearing ticks (4 green cardinals), a thin #7dffa6 ring,
a conic sweep (60-65 deg, 0 -> 75 % green at the line, like the CSS conic-gradient), a pale-mint sweep line, a glowing
center dot and radar blips that obey phosphor persistence.

One file, two roles:
  * Inside Blender (headless) it rebuilds the scene, renders the stills (EXR) and the intro animation (PNG frames),
    measures the brand colours, saves the .blend, then calls itself with system Python for the still post.
  * Under system Python (numpy + Pillow) with --post it turns the still renders into the delivered PNGs.

Run:
  "%LOCALAPPDATA%\\Microsoft\\WindowsApps\\blender-launcher.exe" -b --factory-startup --python brand\\tools\\emblem.py -- <out_dir> [options]
Options (after the --):
  --anim DIR          where frame_0001.png ... are written (default <out_dir>/../video/emblem_frames)
  --blend PATH        where the scene is saved (default brand/blend/emblem.blend)
  --work DIR          intermediates: EXR, npy, logs, check images (default %TEMP%/oo_emblem_work)
  --only WHAT         all | stills | master | anim   (default all; master = 1024 master still only, for tuning)
  --frames LIST       render only these animation frames, e.g. 1,40,80 (quick look)
  --samples N         still samples (default 64)        --anim-samples N   animation samples (default 40)
  --set key=value     override an entry of P (value parsed as JSON), repeatable
Post only (system Python):  python emblem.py --post <out_dir> --work <work_dir>

Animation: 720x720, 30 fps, 120 frames, transparent. The sweep turns clockwise at exactly 3.2 s per revolution
(3.75 deg per frame); at frame 1 the sweep line points at SWEEP0 = 45 deg (clockwise from 12 o'clock), which is the pose
of every still. Frame f shows bearing 45 + 3.75 * (f - 1).

Transparent PNGs: the glow is additive light that also lands where the render alpha is 0, so the PNG alpha is
max(coverage, brightest display channel) and the colour is un-premultiplied from the display-encoded premultiplied
render: over black / #04060a the PNG reproduces the additive glow. RGB is forced to 0 wherever alpha is 0.
"""
import json, math, os, shutil, struct, subprocess, sys, time, zlib
import numpy as np

try:
    import bpy, bmesh
    IN_BLENDER = True
except ImportError:
    IN_BLENDER = False

HERE = os.path.dirname(os.path.abspath(__file__))
BRAND = os.path.dirname(HERE)
BG = (4, 6, 10)
ACC = '#7dffa6'
CIV = '#5fd3ff'
MIL = '#ffb44d'
MINT = '#d6ffe6'
INK_DIM = '#8b9bab'

FPS = 30
REV_S = 3.2
DEG_PER_FRAME = 360.0 / (REV_S * FPS)       # 3.75 deg per frame, clockwise
SWEEP0 = 45.0                               # sweep bearing at frame 1 (= the still pose)
FRAMES = 120
ANIM_SIZE = 720

# ---------------------------------------------------------------- parameters (everything tunable lives here)
P = dict(
    tilt_deg=14.0, lens=100.0, frame=2.40, aim_y=-0.028,   # master: 14 deg off head-on, ~8 % padding
    profile_fill=0.78,                                     # profile picture: emblem width / canvas width
    apple_fill=0.84,                                       # apple-touch-icon: emblem width / canvas width
    z_face=0.03, bezel_in=0.85, bezel_top=0.16,
    gun_hex='#66717d', gun_rough=0.38, gun_aniso=0.7,      # slate (ink-dim hue), not blue steel
    face_hex='#030507', face_rough=0.12, face_spec=0.35,
    wedge_span=62.0, wedge_peak=0.75, wedge_gain=1.0,      # CSS-style: display opacity 0 -> 75 % at the line
    wedge_hub=(0.03, 0.22, 0.55),                          # dims the wedge near the hub (r0, r1, factor at r0)
    ring_r=0.835, ring_minor=0.014, ring_gain=0.55, ring_core=0.10, ring_glow=0.46,
    line_w=0.019, line_hex='#bcffc6', line_gain=1.0, line_glow=0.5,
    dot_r=0.053, dot_hex=ACC, dot_core_hex='#f1ffef', dot_gain=0.6, dot_core_pow=1.5, dot_glow=0.8,
    range_rings=(0.30, 0.57), range_w=0.0045, range_gain=0.14, cross_gain=0.10,
    ticks=36, tick_hex='#3e4650', tick_emit_hex=INK_DIM, tick_emit=0.28, card_gain=0.6, card_glow=0.3,
    blip_tau=20.0,                  # persistence: strength 1.0 at 15 deg behind the line, 0.29 at 40 deg
    blip_max=1.1, blip_hold=14.0, blip_blend=40.0, blip_cut=(45.0, 80.0),
    blip_gain=0.7, blip_glow=0.5,   # emission and halo per unit strength (the halo adds ~0.87x glow at the core)
    glare_strength=0.95, glare_size=0.62,
    key_w=55.0, fill_w=45.0, rim_w=132.0, world_strength=0.28, world_side_min=0.35,
    key_hex='#f4f5f7', fill_hex='#a4acb5', rim_hex='#b8bec5',
    world_stops=((0.0, '#000000'), (0.50, '#0e1116'), (0.62, '#7c838b'), (0.74, '#41464c'), (0.86, '#0b0d10'),
                 (1.0, '#020304')),
)
# name, bearing (deg clockwise from 12 o'clock), radius, size, hot colour while the line passes
BLIPS = (
    ('BlipA', 30.0, 0.47, 0.026, MINT),    # still: 15 deg behind the line -> mint, full
    ('BlipB', 5.0, 0.70, 0.022, MINT),     # still: 40 deg behind -> green ~60 %
    ('BlipC', 177.0, 0.62, 0.024, CIV),    # pings cyan (line passes at frame ~36.5)
    ('BlipD', 250.0, 0.40, 0.022, MINT),   # frame ~55.7
    ('BlipE', 325.0, 0.70, 0.024, MIL),    # pings amber (frame ~75.7)
)


# ---------------------------------------------------------------- colour helpers (pure python)
def srgb2lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_srgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def hex_lin(h):
    return tuple(srgb2lin(c) for c in hex_srgb(h))


def sweep_at(frame):
    return SWEEP0 + (frame - 1) * DEG_PER_FRAME


def blip_state(delta, hot):
    """delta: degrees behind the sweep line (0..360). Returns (linear rgb, emission strength)."""
    tau = P['blip_tau']
    s = min(P['blip_max'] if hot == MINT else 1.0, math.exp((15.0 - delta) / tau))
    c0, c1 = P['blip_cut']
    if delta > c0:
        s *= max(0.0, min(1.0, (c1 - delta) / (c1 - c0)))
    t = max(0.0, min(1.0, (delta - P['blip_hold']) / (P['blip_blend'] - P['blip_hold'])))
    h, g = hex_lin(hot), hex_lin(ACC)
    col = tuple(h[i] * (1 - t) + g[i] * t for i in range(3))
    return col, s


# ---------------------------------------------------------------- shared numpy post (Blender python + system python)
def oetf(x):
    x = np.clip(x, 0.0, 1.0)
    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def encode(px, floor=2.5 / 255):
    """px: HxWx4 scene-linear premultiplied RGBA, top-down. Returns (D, a): display-encoded premultiplied colour and
    alpha = max(coverage, brightest channel), with a soft floor so the far (<1 %) halo becomes fully transparent."""
    A = np.clip(px[..., 3], 0, 1)
    D = oetf(px[..., :3])
    a = np.maximum(A, D.max(axis=2))
    a = np.maximum(A, np.clip((a - floor) / (1 - floor), 0, 1))
    return D.astype(np.float32), a.astype(np.float32)


def straight_u8(D, a):
    am = a[..., None]
    c = np.where(am > 1e-6, D / np.maximum(am, 1e-6), 0)
    out = np.concatenate([np.clip(c, 0, 1), am], axis=2)
    u8 = (out * 255 + 0.5).astype(np.uint8)
    u8[u8[..., 3] == 0, :3] = 0                          # alpha hygiene
    return u8


def over_bg(u8, bg=BG):
    f = u8.astype(np.float32) / 255
    a = f[..., 3:4]
    rgb = f[..., :3] * a + np.array(bg, np.float32) / 255 * (1 - a)
    return (rgb * 255 + 0.5).astype(np.uint8)


def hygiene_violations(u8):
    return int(((u8[..., 3] == 0) & (u8[..., :3].max(axis=2) > 0)).sum())


def write_png(path, u8):
    """Minimal RGBA/RGB 8-bit PNG writer (Blender's python has no Pillow). 'Up' filter on every row."""
    h, w, c = u8.shape
    rows = u8.reshape(h, w * c)
    up = rows.copy()
    up[1:] = rows[1:] - rows[:-1]
    raw = np.concatenate([np.full((h, 1), 2, np.uint8), up], axis=1).tobytes()

    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)

    ctype = 6 if c == 4 else 2
    data = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, ctype, 0, 0, 0)) +
            chunk(b'IDAT', zlib.compress(raw, 6)) + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(data)


# ================================================================ Blender side
def _log(*a):
    msg = ' '.join(str(x) for x in a)
    if _LOG:
        with open(_LOG, 'a', encoding='utf-8') as f:
            f.write(msg + '\n')


_LOG = None


def kv(node, name, value):
    s = node.inputs.get(name)
    if s is None:
        _log('  ! no socket', repr(name), 'on', node.bl_idname, '->', [i.name for i in node.inputs])
        return None
    s.default_value = value
    return s


def sock(coll, name, typ='RGBA'):
    """ShaderNodeMix has several sockets per name (float/vector/colour); pick the colour one."""
    for s in coll:
        if s.name == name and s.type == typ:
            return s
    return coll[name]


def rgba(h, alpha=1.0):
    return (*hex_lin(h), alpha)


def fillet_polygon(corners, arc_steps=10):
    out = []
    n = len(corners)
    for i in range(n):
        x0, y0, _ = corners[i - 1]
        x1, y1, rad = corners[i]
        x2, y2, _ = corners[(i + 1) % n]
        if rad <= 0:
            out.append((x1, y1))
            continue
        a = (x0 - x1, y0 - y1); b = (x2 - x1, y2 - y1)
        la = math.hypot(*a); lb = math.hypot(*b)
        a = (a[0] / la, a[1] / la); b = (b[0] / lb, b[1] / lb)
        ang = math.acos(max(-1.0, min(1.0, a[0] * b[0] + a[1] * b[1])))
        d = min(rad / math.tan(ang / 2), la * 0.49, lb * 0.49)
        p1 = (x1 + a[0] * d, y1 + a[1] * d); p2 = (x1 + b[0] * d, y1 + b[1] * d)
        for k in range(arc_steps + 1):
            t = k / arc_steps; u = 1 - t
            out.append((u * u * p1[0] + 2 * u * t * x1 + t * t * p2[0], u * u * p1[1] + 2 * u * t * y1 + t * t * p2[1]))
    return out


def link_ob(name, me, mat=None):
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    if mat:
        me.materials.append(mat)
    return ob


def lathe(name, profile, segs=384, mat=None, smooth_angle=35):
    bm = bmesh.new()
    rings = []
    for i in range(segs):
        th = 2 * math.pi * i / segs
        c, s = math.cos(th), math.sin(th)
        rings.append([bm.verts.new((r * c, r * s, z)) for r, z in profile])
    n = len(profile)
    for i in range(segs):
        A, Bn = rings[i], rings[(i + 1) % segs]
        for j in range(n):
            k = (j + 1) % n
            bm.faces.new((A[j], Bn[j], Bn[k], A[k]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me); bm.free()
    me.shade_smooth()
    me.set_sharp_from_angle(angle=math.radians(smooth_angle))
    return link_ob(name, me, mat)


def annulus(name, r0, r1, z, mat, segs=384):
    bm = bmesh.new()
    ring = lambda r: [bm.verts.new((r * math.cos(2 * math.pi * i / segs), r * math.sin(2 * math.pi * i / segs), z))
                      for i in range(segs)]
    inner, outer = ring(r0), ring(r1)
    for i in range(segs):
        j = (i + 1) % segs
        bm.faces.new((inner[i], outer[i], outer[j], inner[j]))
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me); bm.free()
    return link_ob(name, me, mat)


def disk(name, r, z, mat, segs=384):
    bm = bmesh.new()
    bm.faces.new([bm.verts.new((r * math.cos(2 * math.pi * i / segs), r * math.sin(2 * math.pi * i / segs), 0))
                  for i in range(segs)])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me); bm.free()
    ob = link_ob(name, me, mat)
    ob.location.z = z
    return ob


def box(name, sx, sy, sz, loc, rot_z, mat, offset=(0, 0, 0)):
    """Box of full size (sx, sy, sz); mesh shifted by offset (so the origin can sit elsewhere), placed at loc."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co.x = v.co.x * sx + offset[0]; v.co.y = v.co.y * sy + offset[1]; v.co.z = v.co.z * sz + offset[2]
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me); bm.free()
    ob = link_ob(name, me, mat)
    ob.location = loc
    ob.rotation_euler = (0, 0, rot_z)
    return ob


def bearing_vec(deg, r):
    a = math.radians(deg)
    return (r * math.sin(a), r * math.cos(a))


# ---------------------------------------------------------------- materials
def aov(nt, color_socket_or_value):
    """Writes the glow source into the 'glow' AOV; the compositor turns that into the Fog Glow halo."""
    n = nt.nodes.new('ShaderNodeOutputAOV')
    n.aov_name = 'glow'
    if isinstance(color_socket_or_value, tuple):
        n.inputs['Color'].default_value = color_socket_or_value
    else:
        nt.links.new(color_socket_or_value, n.inputs['Color'])
    return n


def scaled(col_lin, k):
    return (col_lin[0] * k, col_lin[1] * k, col_lin[2] * k, 1.0)


def mat_emit(name, hexcol, gain, glow=0.0, glow_hex=ACC, core_hex=None, core_pow=1.5, core_gain=0.0):
    """Emission with optional paler core where the surface faces the camera (core_hex) and/or a gentle strength
    lift there (core_gain); glow goes to the AOV in glow_hex (the halo stays brand green)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    N, L = nt.nodes, nt.links
    out = N.new('ShaderNodeOutputMaterial')
    em = N.new('ShaderNodeEmission')
    lw = N.new('ShaderNodeLayerWeight'); lw.inputs['Blend'].default_value = 0.35
    inv = N.new('ShaderNodeMath'); inv.operation = 'SUBTRACT'; inv.inputs[0].default_value = 1.0
    L.new(lw.outputs['Facing'], inv.inputs[1])                                     # 1 facing the camera
    if core_hex:
        pw = N.new('ShaderNodeMath'); pw.operation = 'POWER'; pw.inputs[1].default_value = core_pow
        L.new(inv.outputs[0], pw.inputs[0])
        mix = N.new('ShaderNodeMix'); mix.data_type = 'RGBA'; mix.clamp_factor = True
        L.new(pw.outputs[0], mix.inputs['Factor'])
        sock(mix.inputs, 'A').default_value = rgba(hexcol)
        sock(mix.inputs, 'B').default_value = rgba(core_hex)
        L.new(sock(mix.outputs, 'Result'), em.inputs['Color'])
    else:
        em.inputs['Color'].default_value = rgba(hexcol)
    mad = N.new('ShaderNodeMath'); mad.operation = 'MULTIPLY_ADD'
    L.new(inv.outputs[0], mad.inputs[0])
    mad.inputs[1].default_value = gain * core_gain
    mad.inputs[2].default_value = gain
    L.new(mad.outputs[0], em.inputs['Strength'])
    L.new(em.outputs[0], out.inputs['Surface'])
    if glow > 0:
        aov(nt, scaled(hex_lin(glow_hex), glow))
    return m


def mat_additive(name, hexcol, strength):
    """Faint phosphor line: transparent + emission, so it adds light over the sweep instead of blocking it."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs['Color'].default_value = rgba(hexcol)
    em.inputs['Strength'].default_value = strength
    tr = nt.nodes.new('ShaderNodeBsdfTransparent')
    add = nt.nodes.new('ShaderNodeAddShader')
    nt.links.new(tr.outputs[0], add.inputs[0])
    nt.links.new(em.outputs[0], add.inputs[1])
    nt.links.new(add.outputs[0], out.inputs['Surface'])
    return m


def mat_blip(name):
    """Colour and strength are keyed per frame from blip_state(); the halo follows the same colour."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    N, L = nt.nodes, nt.links
    out = N.new('ShaderNodeOutputMaterial')
    em = N.new('ShaderNodeEmission')
    col = N.new('ShaderNodeRGB'); col.name = 'BlipColor'
    st = N.new('ShaderNodeValue'); st.name = 'BlipStrength'
    L.new(col.outputs[0], em.inputs['Color'])
    L.new(st.outputs[0], em.inputs['Strength'])
    L.new(em.outputs[0], out.inputs['Surface'])
    k = N.new('ShaderNodeMath'); k.operation = 'MULTIPLY'; k.inputs[1].default_value = P['blip_glow'] / P['blip_gain']
    L.new(st.outputs[0], k.inputs[0])
    sc = N.new('ShaderNodeVectorMath'); sc.operation = 'SCALE'
    L.new(col.outputs[0], sc.inputs[0])
    L.new(k.outputs[0], sc.inputs['Scale'])
    aov(nt, sc.outputs[0])
    return m


def mat_gunmetal():
    m = bpy.data.materials.new('Gunmetal')
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes.get('Principled BSDF')
    kv(bsdf, 'Base Color', rgba(P['gun_hex']))
    kv(bsdf, 'Metallic', 1.0)
    kv(bsdf, 'Roughness', P['gun_rough'])
    kv(bsdf, 'Anisotropic', P['gun_aniso'])
    tan = nt.nodes.new('ShaderNodeTangent')
    tan.direction_type = 'RADIAL'
    tan.axis = 'Z'
    nt.links.new(tan.outputs['Tangent'], bsdf.inputs['Tangent'])
    return m


def mat_ticks():
    m = bpy.data.materials.new('TickPaint')
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get('Principled BSDF')
    kv(bsdf, 'Base Color', rgba(P['tick_hex']))
    kv(bsdf, 'Roughness', 0.5)
    kv(bsdf, 'Emission Color', rgba(P['tick_emit_hex']))
    kv(bsdf, 'Emission Strength', P['tick_emit'])
    return m


def mat_face():
    """Dark scope glass with the sweep wedge in its emission. Bearing of each point (object space) against the keyed
    'Sweep' value: display opacity ramps linearly 0 -> wedge_peak over wedge_span degrees behind the line, and the
    emission is the sRGB-decoded brand green at that opacity (so it composites like the CSS conic-gradient)."""
    m = bpy.data.materials.new('ScopeFace')
    m.use_nodes = True
    nt = m.node_tree
    N, L = nt.nodes, nt.links
    bsdf = N.get('Principled BSDF')
    kv(bsdf, 'Base Color', rgba(P['face_hex']))
    kv(bsdf, 'Roughness', P['face_rough'])
    kv(bsdf, 'Specular IOR Level', P['face_spec'])
    kv(bsdf, 'Emission Strength', 1.0)

    def mnode(op, a=None, b=None, c=None):
        n = N.new('ShaderNodeMath'); n.operation = op
        for i, v in enumerate((a, b, c)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                n.inputs[i].default_value = v
            else:
                L.new(v, n.inputs[i])
        return n.outputs[0]

    tc = N.new('ShaderNodeTexCoord')
    sep = N.new('ShaderNodeSeparateXYZ')
    L.new(tc.outputs['Object'], sep.inputs[0])
    sweep = N.new('ShaderNodeValue'); sweep.name = 'Sweep'; sweep.label = 'Sweep (rad, keyed)'
    sweep.outputs[0].default_value = math.radians(SWEEP0)
    bearing = mnode('ARCTAN2', sep.outputs['X'], sep.outputs['Y'])                 # clockwise from +Y
    behind = mnode('FLOORED_MODULO', mnode('SUBTRACT', sweep.outputs[0], bearing), 2 * math.pi)
    mr = N.new('ShaderNodeMapRange'); mr.clamp = True
    L.new(behind, mr.inputs['Value'])
    mr.inputs['From Min'].default_value = 0.0
    mr.inputs['From Max'].default_value = math.radians(P['wedge_span'])
    mr.inputs['To Min'].default_value = P['wedge_peak']
    mr.inputs['To Max'].default_value = 0.0
    f = mr.outputs['Result']
    g = hex_srgb(ACC)
    c0 = (0.055 / 1.055) ** 2.4
    chans = []
    for gc in g:                                    # lin = ((f*g + 0.055) / 1.055) ^ 2.4 - lin(0)
        x = mnode('MULTIPLY_ADD', f, gc / 1.055, 0.055 / 1.055)
        chans.append(mnode('MAXIMUM', mnode('SUBTRACT', mnode('POWER', x, 2.4), c0), 0.0))
    comb = N.new('ShaderNodeCombineColor')
    for s, ch in zip(('Red', 'Green', 'Blue'), chans):
        L.new(ch, comb.inputs[s])
    vlen = N.new('ShaderNodeVectorMath'); vlen.operation = 'LENGTH'
    L.new(tc.outputs['Object'], vlen.inputs[0])
    hub = N.new('ShaderNodeMapRange'); hub.clamp = True
    L.new(vlen.outputs['Value'], hub.inputs['Value'])
    hub.inputs['From Min'].default_value = P['wedge_hub'][0]
    hub.inputs['From Max'].default_value = P['wedge_hub'][1]
    hub.inputs['To Min'].default_value = P['wedge_hub'][2]
    hub.inputs['To Max'].default_value = 1.0
    k = mnode('MULTIPLY', hub.outputs['Result'], P['wedge_gain'])
    sc = N.new('ShaderNodeVectorMath'); sc.operation = 'SCALE'
    L.new(comb.outputs[0], sc.inputs[0])
    L.new(k, sc.inputs['Scale'])
    L.new(sc.outputs[0], bsdf.inputs['Emission Color'])
    return m


def world_gradient(scene):
    w = bpy.data.worlds.new('World')
    w.use_nodes = True
    scene.world = w
    nt = w.node_tree
    N, L = nt.nodes, nt.links
    bg = N.get('Background') or N.new('ShaderNodeBackground')
    tc = N.new('ShaderNodeTexCoord')
    sep = N.new('ShaderNodeSeparateXYZ')
    L.new(tc.outputs['Generated'], sep.inputs[0])
    mr = N.new('ShaderNodeMapRange'); mr.clamp = True
    L.new(sep.outputs['Z'], mr.inputs['Value'])
    mr.inputs['From Min'].default_value = -1.0
    mr.inputs['From Max'].default_value = 1.0
    ramp = N.new('ShaderNodeValToRGB')
    L.new(mr.outputs['Result'], ramp.inputs['Fac'])
    els = ramp.color_ramp.elements
    stops = P['world_stops']
    els[0].position, els[0].color = stops[0][0], rgba(stops[0][1])
    els[1].position, els[1].color = stops[-1][0], rgba(stops[-1][1])
    for pos, col in stops[1:-1]:
        e = els.new(pos); e.color = rgba(col)
    dp = N.new('ShaderNodeVectorMath'); dp.operation = 'DOT_PRODUCT'
    L.new(tc.outputs['Generated'], dp.inputs[0])
    dp.inputs[1].default_value = (-0.707, 0.707, 0.0)
    side = N.new('ShaderNodeMapRange'); side.clamp = True
    L.new(dp.outputs['Value'], side.inputs['Value'])
    side.inputs['From Min'].default_value = -1.0
    side.inputs['From Max'].default_value = 1.0
    side.inputs['To Min'].default_value = P['world_side_min']
    side.inputs['To Max'].default_value = 1.0
    mul = N.new('ShaderNodeMix'); mul.data_type = 'RGBA'; mul.blend_type = 'MULTIPLY'
    mul.inputs['Factor'].default_value = 1.0
    L.new(ramp.outputs['Color'], sock(mul.inputs, 'A'))
    L.new(side.outputs['Result'], sock(mul.inputs, 'B'))
    L.new(sock(mul.outputs, 'Result'), bg.inputs['Color'])
    bg.inputs['Strength'].default_value = P['world_strength']


def area_light(name, loc, size, watts, col, target=(0, 0, 0)):
    from mathutils import Vector
    ld = bpy.data.lights.new(name, 'AREA')
    ld.shape = 'DISK'
    ld.size = size
    ld.energy = watts
    ld.color = hex_lin(col)
    ob = bpy.data.objects.new(name, ld)
    ob.location = loc
    bpy.context.scene.collection.objects.link(ob)
    ob.rotation_euler = (Vector(target) - ob.location).to_track_quat('-Z', 'Y').to_euler()
    return ob


# ---------------------------------------------------------------- build
def build(scene):
    zf = P['z_face']
    gun = mat_gunmetal()
    face = mat_face()
    paint = mat_ticks()
    ring = mat_emit('Ring', ACC, P['ring_gain'], glow=P['ring_glow'], core_gain=P['ring_core'])
    line = mat_emit('SweepLine', P['line_hex'], P['line_gain'], glow=P['line_glow'])
    dot = mat_emit('CenterDot', P['dot_hex'], P['dot_gain'], glow=P['dot_glow'], core_hex=P['dot_core_hex'],
                   core_pow=P['dot_core_pow'])
    card = mat_emit('TickCardinal', ACC, P['card_gain'], glow=P['card_glow'])
    faint = mat_additive('Graticule', ACC, P['range_gain'])
    cross = mat_additive('Cross', ACC, P['cross_gain'])

    bi, bt = P['bezel_in'], P['bezel_top']
    corners = [
        (bi, 0.0, 0.0),
        (bi, bt - 0.028, 0.010),        # inner lip
        (bi + 0.03, bt, 0.010),          # chamfer up onto the top flat
        (0.955, bt, 0.040),              # big outer round
        (1.0, bt - 0.06, 0.012),
        (1.0, 0.02, 0.008),
        (0.975, 0.0, 0.0),
    ]
    lathe('Bezel', fillet_polygon(corners), mat=gun)
    disk('Face', bi + 0.002, zf, face)

    bpy.ops.mesh.primitive_torus_add(major_radius=P['ring_r'], minor_radius=P['ring_minor'],
                                     major_segments=384, minor_segments=24, location=(0, 0, zf + P['ring_minor'] * 0.6))
    tor = bpy.context.active_object; tor.name = 'Ring'
    tor.data.materials.append(ring)
    tor.data.shade_smooth()

    for i, r in enumerate(P['range_rings']):
        annulus(f'Range{i}', r - P['range_w'] / 2, r + P['range_w'] / 2, zf + 0.0012, faint)
    Lc = 2 * 0.80
    box('CrossV', 0.0045, Lc, 0.001, (0, 0, zf + 0.0011), 0.0, cross)
    box('CrossH', Lc, 0.0045, 0.001, (0, 0, zf + 0.0011), 0.0, cross)

    # bearing ticks printed on the bezel top: every 10 deg, majors every 30, the 4 cardinals green
    r_in, r_out = bi + 0.045, 0.945
    step = 360 // P['ticks']
    for k in range(P['ticks']):
        deg = k * step
        major = deg % 30 == 0
        cardinal = deg % 90 == 0
        ln = (r_out - r_in) if major else (r_out - r_in) * 0.5
        w = 0.010 if major else 0.0065
        x, y = bearing_vec(deg, r_out - ln / 2)
        box(f'Tick{deg:03d}', w, ln, 0.002, (x, y, bt + 0.0006), -math.radians(deg), card if cardinal else paint)

    # the sweep: an empty turning clockwise; the line is its child, the wedge reads the same angle (keyed value)
    sw = bpy.data.objects.new('Sweep', None)
    scene.collection.objects.link(sw)
    r0, r1 = 0.045, P['ring_r'] - P['ring_minor'] * 1.2
    ln = box('SweepLine', P['line_w'], r1 - r0, P['line_w'] * 0.5, (0, 0, zf + 0.004), 0.0, line,
             offset=(0, (r0 + r1) / 2, 0))
    ln.parent = sw

    bpy.ops.mesh.primitive_uv_sphere_add(radius=P['dot_r'], segments=48, ring_count=24, location=(0, 0, zf + 0.004))
    d = bpy.context.active_object; d.name = 'CenterDot'; d.scale.z = 0.45
    d.data.materials.append(dot); d.data.shade_smooth()

    blips = []
    for name, deg, r, size, hot in BLIPS:
        x, y = bearing_vec(deg, r)
        bpy.ops.mesh.primitive_uv_sphere_add(radius=size, segments=32, ring_count=16, location=(x, y, zf + 0.003))
        b = bpy.context.active_object; b.name = name; b.scale.z = 0.4
        mb = mat_blip(name)
        b.data.materials.append(mb); b.data.shade_smooth()
        blips.append((mb, deg, hot))

    world_gradient(scene)
    area_light('Key', (-3.2, 3.6, 5.2), 3.5, P['key_w'], P['key_hex'])
    area_light('Fill', (3.8, -2.6, 2.2), 2.0, P['fill_w'], P['fill_hex'])
    area_light('Rim', (3.0, -2.2, 0.35), 1.5, P['rim_w'], P['rim_hex'], target=(0, 0, 0.05))

    # ---- animation: one key per frame (exact values on every rendered frame, no fcurve API needed)
    sweep_node = face.node_tree.nodes['Sweep']
    for f in range(1, FRAMES + 1):
        a = sweep_at(f)
        sw.rotation_euler = (0, 0, -math.radians(a))
        sw.keyframe_insert('rotation_euler', index=2, frame=f)
        sweep_node.outputs[0].default_value = math.radians(a)
        sweep_node.outputs[0].keyframe_insert('default_value', frame=f)
        for mb, deg, hot in blips:
            col, s = blip_state((a - deg) % 360.0, hot)
            cn = mb.node_tree.nodes['BlipColor']; sn = mb.node_tree.nodes['BlipStrength']
            cn.outputs[0].default_value = (*col, 1.0)
            cn.outputs[0].keyframe_insert('default_value', frame=f)
            sn.outputs[0].default_value = s * P['blip_gain']
            sn.outputs[0].keyframe_insert('default_value', frame=f)
    scene.frame_start, scene.frame_end = 1, FRAMES
    scene.render.fps = FPS
    scene.frame_set(1)


def setup_render(scene, size, samples):
    sys.path.insert(0, HERE)
    import bl_common as B
    B._LOG = _LOG
    B.setup_cycles(scene, size, size, samples=samples, transparent=True)
    scene.view_settings.view_transform = 'Standard'     # brand hexes come out exact; the glow is the compositor's
    scene.cycles.max_bounces = 6
    scene.render.use_persistent_data = True


def setup_compositor(scene):
    """Render Layers: Image + 'glow' AOV. Fog Glow of the AOV only (threshold 0) is added to the image, then the
    render's own coverage alpha is put back (the post derives the glow alpha itself)."""
    vl = scene.view_layers[0]
    if 'glow' not in [a.name for a in vl.aovs]:
        a = vl.aovs.add(); a.name = 'glow'; a.type = 'COLOR'
    ng = bpy.data.node_groups.new('Comp', 'CompositorNodeTree')
    ng.interface.new_socket(name='Image', in_out='OUTPUT', socket_type='NodeSocketColor')
    scene.compositing_node_group = ng
    N, L = ng.nodes, ng.links
    rl = N.new('CompositorNodeRLayers')
    gl = N.new('CompositorNodeGlare')
    gl.inputs['Type'].default_value = 'Fog Glow'
    gl.inputs['Quality'].default_value = 'High'
    gl.inputs['Threshold'].default_value = 0.0
    gl.inputs['Strength'].default_value = P['glare_strength']
    gl.inputs['Size'].default_value = P['glare_size']
    L.new(rl.outputs['glow'], gl.inputs['Image'])
    add = N.new('ShaderNodeMix'); add.data_type = 'RGBA'; add.blend_type = 'ADD'
    add.inputs['Factor'].default_value = 1.0
    L.new(rl.outputs['Image'], sock(add.inputs, 'A'))
    L.new(gl.outputs['Glare'], sock(add.inputs, 'B'))
    sa = N.new('CompositorNodeSetAlpha')
    _log('set alpha inputs', [(i.name, getattr(i, 'default_value', None)) for i in sa.inputs])
    if sa.inputs.get('Type') is not None:
        sa.inputs['Type'].default_value = 'Replace Alpha'
    L.new(sock(add.outputs, 'Result'), sa.inputs['Image'])
    L.new(rl.outputs['Alpha'], sa.inputs['Alpha'])
    out = N.new('NodeGroupOutput')
    L.new(sa.outputs[0], out.inputs[0])


def set_view(scene, cam, tilt, frame, aim_y):
    from mathutils import Vector
    t = math.radians(tilt)
    dist = frame / (36.0 / P['lens'])
    cam.location = (0, aim_y - dist * math.sin(t), dist * math.cos(t) + 0.06)
    cam.rotation_euler = (Vector((0, aim_y, 0.06)) - cam.location).to_track_quat('-Z', 'Y').to_euler()


def render_exr(scene, path, half=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    s = scene.render.image_settings
    s.file_format = 'OPEN_EXR'; s.color_mode = 'RGBA'; s.color_depth = '16' if half else '32'
    s.exr_codec = 'ZIP'
    scene.render.filepath = path
    t0 = time.time()
    bpy.ops.render.render(write_still=True)
    _log('rendered', os.path.basename(path), round(time.time() - t0, 2), 's')
    return load_exr(path)


def load_exr(path):
    img = bpy.data.images.load(path)
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    return px.reshape(h, w, 4)[::-1].copy()


# ---------------------------------------------------------------- measurement (on the #04060a composite)
def measure(scene, dark):
    from bpy_extras.object_utils import world_to_camera_view
    from mathutils import Vector
    cam = scene.camera
    H, W = dark.shape[:2]
    deps = bpy.context.evaluated_depsgraph_get()
    zf = P['z_face']

    def px(co):
        v = world_to_camera_view(scene, cam, Vector(co))
        return int(round(v.x * W - 0.5)), int(round((1 - v.y) * H - 0.5))

    def at(co):
        x, y = px(co)
        return dark[y, x].tolist()

    def brightest(co, rad):
        x, y = px(co)
        win = dark[y - rad:y + rad + 1, x - rad:x + rad + 1].reshape(-1, 3).astype(int)
        return win[np.argmax(win.sum(1))].tolist()

    res = {}
    ztop = zf + P['ring_minor'] * 1.6
    ring = [brightest((*bearing_vec(b, P['ring_r']), ztop), 6) for b in (100, 135, 160, 200, 225, 260, 300)]
    res['ring_core'] = ring
    res['ring_core_mean'] = [round(v, 1) for v in np.mean(ring, axis=0)]
    res['dot_core'] = brightest((0, 0, zf + 0.004 + P['dot_r'] * 0.45), 4)
    sw = sweep_at(scene.frame_current)
    res['line_core'] = [brightest((*bearing_vec(sw, r), zf + 0.0135), 2) for r in (0.3, 0.6)]
    wedge = {}
    for d in (3, 6, 10, 20, 31, 45, 58, 66):
        wedge[d] = at((*bearing_vec(sw - d, 0.45), zf))
    res['wedge_r045'] = wedge
    res['wedge_targets'] = {d: [round(BG[i] + (int(ACC[1 + 2 * i:3 + 2 * i], 16) - BG[i]) * P['wedge_peak'] *
                                      max(0.0, 1 - d / P['wedge_span'])) for i in range(3)] for d in wedge}
    res['blips'] = {}
    for name, deg, r, size, hot in BLIPS:
        res['blips'][name] = [round((sw - deg) % 360, 1), brightest((*bearing_vec(deg, r), zf + 0.003 + size * 0.4), 3)]
    # bezel: ray-cast camera -> points of the bezel surface half way between ticks; keep only visible ones
    bi, bt = P['bezel_in'], P['bezel_top']
    prof = [(bi + 0.001, z) for z in np.linspace(0.04, bt - 0.03, 6)] + \
           [(r, bt + 0.0005) for r in np.linspace(bi + 0.035, 0.95, 10)] + \
           [(0.955 + 0.045 * math.sin(t), bt - 0.04 + 0.04 * math.cos(t)) for t in np.linspace(0.2, 1.5, 6)] + \
           [(1.001, z) for z in np.linspace(0.03, bt - 0.07, 4)]
    bez = []
    for k in range(36):
        b = k * 10 + 5
        for r, z in prof:
            co = Vector((*bearing_vec(b, r), z))
            d = co - cam.location
            hit, loc, nrm, idx, ob, mtx = scene.ray_cast(deps, cam.location, d.normalized(), distance=d.length + 0.01)
            if hit and ob.name == 'Bezel' and (loc - co).length < 0.004:
                bez.append(at(co) + [b, round(r, 3), round(z, 3)])
    bez = np.array(bez)
    if len(bez):
        rgb = bez[:, :3]
        greenish = (rgb[:, 1] - np.maximum(rgb[:, 0], rgb[:, 2])) > 12
        metal = bez[~greenish]
        i = np.argmax(metal[:, :3].sum(1))
        res['bezel_samples'] = int(len(bez))
        res['bezel_max_metal'] = metal[i].tolist()
        res['bezel_p95_metal'] = np.percentile(metal[:, :3], 95, axis=0).round(1).tolist()
        res['bezel_median'] = np.median(rgb, axis=0).round(1).tolist()
        res['bezel_max_greenish'] = bez[greenish][np.argmax(bez[greenish][:, :3].sum(1))].tolist() if greenish.any() else None
    return res


# ---------------------------------------------------------------- main (Blender)
def parse_args(argv):
    o = dict(out=None, anim=None, blend=None, work=None, only='all', frames=None, samples=64, anim_samples=40,
             sets=[], post=False)
    i = 0
    pos = []
    while i < len(argv):
        a = argv[i]
        if a == '--post':
            o['post'] = True
        elif a in ('--anim', '--blend', '--work', '--only', '--frames', '--samples', '--anim-samples', '--set'):
            v = argv[i + 1]; i += 1
            if a == '--set':
                o['sets'].append(v)
            else:
                o[a[2:].replace('-', '_')] = v
        else:
            pos.append(a)
        i += 1
    o['out'] = os.path.abspath(pos[0]) if pos else os.path.join(BRAND, 'emblem')
    o['anim'] = os.path.abspath(o['anim']) if o['anim'] else os.path.join(BRAND, 'video', 'emblem_frames')
    o['blend'] = os.path.abspath(o['blend']) if o['blend'] else os.path.join(BRAND, 'blend', 'emblem.blend')
    import tempfile
    o['work'] = os.path.abspath(o['work']) if o['work'] else os.path.join(tempfile.gettempdir(), 'oo_emblem_work')
    o['samples'] = int(o['samples']); o['anim_samples'] = int(o['anim_samples'])
    for s in o['sets']:
        k, v = s.split('=', 1)
        P[k] = json.loads(v)
    return o


def blender_main(o):
    work = o['work']
    os.makedirs(work, exist_ok=True)
    _log('params', json.dumps(P))
    _log('args', json.dumps({k: v for k, v in o.items()}))
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    setup_render(scene, 1024, o['samples'])
    build(scene)
    from mathutils import Vector
    cd = bpy.data.cameras.new('Camera'); cd.lens = P['lens']
    cam = bpy.data.objects.new('Camera', cd); scene.collection.objects.link(cam); scene.camera = cam
    set_view(scene, cam, P['tilt_deg'], P['frame'], P['aim_y'])
    setup_compositor(scene)
    os.makedirs(os.path.dirname(o['blend']), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=o['blend'], compress=True)
    _log('saved', o['blend'])

    report = {}
    if o['only'] in ('all', 'stills', 'master'):
        scene.frame_set(1)
        views = [('master', 1024, P['tilt_deg'], P['frame'], P['aim_y'])]
        if o['only'] != 'master':
            views += [('front', 1024, 0.0, P['frame'], 0.0),
                      ('profile', 1080, P['tilt_deg'], 2.01 / P['profile_fill'], P['aim_y'])]
        for name, size, tilt, frame, aim in views:
            scene.render.resolution_x = scene.render.resolution_y = size
            scene.cycles.samples = o['samples']
            set_view(scene, cam, tilt, frame, aim)
            px = render_exr(scene, os.path.join(work, f'{name}.exr'))
            np.save(os.path.join(work, f'{name}.npy'), px)
            D, a = encode(px)
            u8 = straight_u8(D, a)
            dark = over_bg(u8)
            write_png(os.path.join(work, f'check_{name}_on_dark.png'), dark)
            if name == 'master':
                report['master'] = measure(scene, dark)
                _log('MEASURE', json.dumps(report['master']))
        set_view(scene, cam, P['tilt_deg'], P['frame'], P['aim_y'])

    if o['only'] in ('all', 'anim'):
        os.makedirs(o['anim'], exist_ok=True)
        scene.render.resolution_x = scene.render.resolution_y = ANIM_SIZE
        scene.cycles.samples = o['anim_samples']
        set_view(scene, cam, P['tilt_deg'], P['frame'], P['aim_y'])
        exr_dir = os.path.join(work, 'anim_exr')
        os.makedirs(exr_dir, exist_ok=True)
        s = scene.render.image_settings
        s.file_format = 'OPEN_EXR'; s.color_mode = 'RGBA'; s.color_depth = '16'; s.exr_codec = 'ZIP'
        scene.render.filepath = os.path.join(exr_dir, 'f_')
        frames = [int(x) for x in o['frames'].split(',')] if o['frames'] else list(range(1, FRAMES + 1))
        t0 = time.time()
        if o['frames']:
            for f in frames:
                scene.frame_start = scene.frame_end = f
                bpy.ops.render.render(animation=True)
            scene.frame_start, scene.frame_end = 1, FRAMES
        else:
            scene.frame_start, scene.frame_end = 1, FRAMES
            bpy.ops.render.render(animation=True)
        _log('animation render', len(frames), 'frames', round(time.time() - t0, 1), 's')
        bad = 0
        for f in frames:
            px = load_exr(os.path.join(exr_dir, f'f_{f:04d}.exr'))
            u8 = straight_u8(*encode(px))
            bad += hygiene_violations(u8)
            write_png(os.path.join(o['anim'], f'frame_{f:04d}.png'), u8)
        _log('frames written', len(frames), 'hygiene violations', bad, 'convert s', round(time.time() - t0, 1))
        report['anim'] = dict(frames=len(frames), hygiene_violations=bad, sweep_frame1=SWEEP0,
                              deg_per_frame=DEG_PER_FRAME)
        scene.frame_set(1)

    bpy.ops.wm.save_as_mainfile(filepath=o['blend'], compress=True)
    with open(os.path.join(work, 'report_blender.json'), 'w') as f:
        json.dump(report, f, indent=1)

    if o['only'] in ('all', 'stills'):
        py = shutil.which('python') or shutil.which('py')
        _log('post with', py)
        r = subprocess.run([py, os.path.abspath(__file__), '--post', o['out'], '--work', work],
                           capture_output=True, text=True)
        _log('post exit', r.returncode, r.stdout[-3000:], r.stderr[-3000:])


# ================================================================ system-python post (Pillow)
def resample(D, a, size, box=None):
    """Lanczos in premultiplied space (D is already premultiplied), each channel as a float image."""
    from PIL import Image
    chans = [np.asarray(Image.fromarray(np.ascontiguousarray(ch, np.float32), 'F').resize(
        (size, size), Image.LANCZOS, box=box)) for ch in (D[..., 0], D[..., 1], D[..., 2], a)]
    a2 = np.clip(chans[3], 0, 1)
    D2 = np.minimum(np.clip(np.stack(chans[:3], 2), 0, None), a2[..., None])
    return D2, a2


def dark_from(D, a, bg=BG):
    rgb = D + np.array(bg, np.float32) / 255 * (1 - a[..., None])
    return (np.clip(rgb, 0, 1) * 255 + 0.5).astype(np.uint8)


def bbox(a, thr=0.5):
    ys, xs = np.where(a > thr)
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def post_main(o):
    from PIL import Image
    out, work = o['out'], o['work']
    os.makedirs(out, exist_ok=True)
    rep = {}

    def save(u8, name, folder=out):
        mode = 'RGBA' if u8.shape[2] == 4 else 'RGB'
        Image.fromarray(u8, mode).save(os.path.join(folder, name), optimize=True)
        if mode == 'RGBA':
            rep.setdefault('hygiene_violations', {})[name] = hygiene_violations(u8)

    m = np.load(os.path.join(work, 'master.npy'))
    D, a = encode(m)
    u = straight_u8(D, a)
    save(u, 'emblem-1024.png')
    save(over_bg(u), 'emblem-on-dark-1024.png')
    x0, y0, x1, y1 = bbox(u[..., 3] / 255)
    rep['master_bbox'] = (x0, y0, x1, y1)
    rep['master_padding_pct'] = [round(v / 1024 * 100, 1) for v in (x0, 1023 - x1, y0, 1023 - y1)]
    disk_w = x1 - x0 + 1
    for s in (512, 256):
        save(straight_u8(*resample(D, a, s)), f'emblem-{s}.png')

    f = np.load(os.path.join(work, 'front.npy'))
    uf = straight_u8(*encode(f))
    save(uf, 'emblem-front-1024.png')
    fb = bbox(uf[..., 3] / 255)
    rep['front_padding_pct'] = [round(v / 1024 * 100, 1) for v in (fb[0], 1023 - fb[2], fb[1], 1023 - fb[3])]

    p = np.load(os.path.join(work, 'profile.npy'))
    Dp, ap = encode(p)
    save(dark_from(Dp, ap), 'profile-1080.png')
    pb = bbox(ap)
    rep['profile_emblem_width_pct'] = round((pb[2] - pb[0] + 1) / 1080 * 100, 1)

    # apple-touch-icon: crop the master so the emblem is apple_fill of the canvas, resample to 180
    cw = min(1024.0, disk_w / P['apple_fill'])
    cx = min(max((x0 + x1 + 1) / 2, cw / 2), 1024 - cw / 2)
    cy = min(max(512.0, cw / 2), 1024 - cw / 2)
    D2, a2 = resample(D, a, 180, box=(cx - cw / 2, cy - cw / 2, cx + cw / 2, cy + cw / 2))
    save(dark_from(D2, a2), 'apple-touch-icon.png')
    rep['apple_emblem_width_pct'] = round(bbox(a2)[2] - bbox(a2)[0] + 1, 1) / 180 * 100

    # review images (work dir): 64 px and 32 px of the on-dark master, plus a blown-up sheet
    D64, a64 = resample(D, a, 64)
    d64 = dark_from(D64, a64)
    D32, a32 = resample(D, a, 32)
    d32 = dark_from(D32, a32)
    Image.fromarray(d64).save(os.path.join(work, 'check_64.png'))
    sheet = Image.new('RGB', (10 + 64 + 10 + 32 + 10 + 512 + 10 + 256 + 10, 532), BG)
    sheet.paste(Image.fromarray(d64), (10, 10)); sheet.paste(Image.fromarray(d32), (84, 10))
    sheet.paste(Image.fromarray(d64).resize((512, 512), Image.NEAREST), (126, 10))
    sheet.paste(Image.fromarray(d32).resize((256, 256), Image.NEAREST), (648, 10))
    sheet.save(os.path.join(work, 'check_small_sheet.png'))
    with open(os.path.join(work, 'report_post.json'), 'w') as fh:
        json.dump(rep, fh, indent=1)
    print(json.dumps(rep))


if __name__ == '__main__':
    argv = sys.argv[sys.argv.index('--') + 1:] if (IN_BLENDER and '--' in sys.argv) else sys.argv[1:]
    opts = parse_args(argv)
    if opts['post'] or not IN_BLENDER:
        post_main(opts)
    else:
        import traceback
        _LOG = os.path.join(opts['work'], 'emblem.log')
        os.makedirs(opts['work'], exist_ok=True)
        open(_LOG, 'w', encoding='utf-8').close()
        try:
            blender_main(opts)
            _log('DONE')
            sys.stdout.flush()
            os._exit(0)
        except BaseException:
            _log(traceback.format_exc())
            os._exit(1)
