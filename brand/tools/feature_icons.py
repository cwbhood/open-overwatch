"""Six 3D "feature icons" for the Open Overwatch landing page, modelled and rendered in headless Blender.

    blender-launcher.exe -b --factory-startup --python brand/tools/feature_icons.py -- brand/lander/icons
        [--only aircraft,ship] [--samples 112] [--size 768] [--no-post]
At the end it runs the post step with the system Python (needs numpy + Pillow); to redo only that:
    python brand/tools/feature_icons.py --post brand/lander/icons

Icons: aircraft, satellite, ship, quake, storm, camera. Each object is glossy dark gunmetal with emissive accent
lines/edges in its layer colour, floating over a thin "holo plinth" (dark disc + glowing ring), one 3/4 camera
(25 deg elevation) and one three-point studio rig for the whole set. Outputs per icon: <name>.png (768x768 RGBA,
transparent) and <name>.webp, plus contact.png (3x2 sheet on #04060a).

Glow: emissive materials also write a 'glow' AOV; the compositor Fog-Glows that AOV and adds it to the image, then
restores the coverage alpha. The render is saved as float EXR (premultiplied) and the post derives
alpha = max(coverage, brightest display channel), as in emblem.py, so the halo survives on transparent pixels.
Intermediates (npy, log, 180 px check sheet) go to %TEMP%/oo_feature_icons (or $OW_ICONS_WORK); see WORK below.
"""
import math, os, sys, time, json, subprocess, tempfile
import numpy as np

try:
    import bpy, bmesh
    from mathutils import Vector, Matrix, Quaternion
    IN_BLENDER = True
except ImportError:
    IN_BLENDER = False

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
BG = (4, 6, 10)
ICONS = [('aircraft', '#5fd3ff'), ('satellite', '#d9ccff'), ('ship', '#62e0c8'),
         ('quake', '#ff7b4f'), ('storm', '#ffd45c'), ('camera', '#ff4d5e')]
# Intermediates (npy, log, 180 px check sheet). Default: %TEMP%/oo_feature_icons (verified visible to the system
# Python). NOTE: the Store build of Blender gets a virtualised %LOCALAPPDATA%: new folders it creates there (e.g.
# %LOCALAPPDATA%/open-overwatch-brand/...) land in %LOCALAPPDATA%/Packages/BlenderFoundation.Blender_*/LocalCache/Local
# instead, so don't point OW_ICONS_WORK there.
WORK = os.environ.get('OW_ICONS_WORK', '')


def set_work(out):
    global WORK
    WORK = WORK or os.path.join(tempfile.gettempdir(), 'oo_feature_icons')
    os.makedirs(WORK, exist_ok=True)

P = dict(
    size=768, samples=112,
    az=35.0, el=25.0, lens=50.0, dist=4.6, aim_z=0.52,      # the one camera: 3/4 view, 25 deg above the horizon
    gun_hex='#737d89', gun_rough=0.28, coat=0.6,
    plinth_r=1.0, plinth_h=0.07,
    fit_w=0.76, fit_top=0.93, fit_bottom=0.04, fit_w_icon=dict(quake=0.68, camera=0.70, storm=0.78, ship=0.80),                                # object's projected width / top edge (0..1 of frame)
    key_w=170.0, fill_w=150.0, rim_w=420.0, world_strength=0.6,
    glare_strength=0.85, glare_size=0.62,
    world_stops=((0.0, '#000000'), (0.50, '#0e1116'), (0.62, '#7c838b'), (0.74, '#41464c'), (0.86, '#0b0d10'),
                 (1.0, '#020304')),
)

_LOG = None


def log(*a):
    if _LOG:
        with open(_LOG, 'a', encoding='utf-8') as f:
            f.write(' '.join(str(x) for x in a) + '\n')


# ---------------------------------------------------------------- colour helpers
def srgb2lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_srgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def hex_lin(h):
    return tuple(srgb2lin(c) for c in hex_srgb(h))


def rgba(h, a=1.0):
    return (*hex_lin(h), a)


def mix_hex(a, b, t):
    ca, cb = hex_srgb(a), hex_srgb(b)
    return '#' + ''.join('%02x' % round((x + (y - x) * t) * 255) for x, y in zip(ca, cb))


# ---------------------------------------------------------------- shared numpy post (same maths as emblem.py)
def oetf(x):
    x = np.clip(x, 0.0, 1.0)
    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def encode(px, floor=2.5 / 255):
    A = np.clip(px[..., 3], 0, 1)
    D = oetf(px[..., :3])
    a = np.maximum(A, D.max(axis=2))
    a = np.maximum(A, np.clip((a - floor) / (1 - floor), 0, 1))
    return D.astype(np.float32), a.astype(np.float32)


def straight_u8(D, a):
    am = a[..., None]
    c = np.where(am > 1e-6, D / np.maximum(am, 1e-6), 0)
    u8 = (np.concatenate([np.clip(c, 0, 1), am], axis=2) * 255 + 0.5).astype(np.uint8)
    u8[u8[..., 3] == 0, :3] = 0
    return u8


def over_bg(u8, bg=BG):
    f = u8.astype(np.float32) / 255
    a = f[..., 3:4]
    rgb = f[..., :3] * a + np.array(bg, np.float32) / 255 * (1 - a)
    return (rgb * 255 + 0.5).astype(np.uint8)


# ================================================================ Blender side
def kv(node, name, value):
    s = node.inputs.get(name)
    if s is None:
        log('  ! no socket', repr(name), 'on', node.bl_idname)
        return None
    s.default_value = value
    return s


def sock(coll, name, typ='RGBA'):
    for s in coll:
        if s.name == name and s.type == typ:
            return s
    return coll[name]


class NT:
    """Tiny node-building helper around one material's node tree."""

    def __init__(self, m):
        self.N, self.L = m.node_tree.nodes, m.node_tree.links

    def math(self, op, a, b=None, clamp=False):
        n = self.N.new('ShaderNodeMath'); n.operation = op; n.use_clamp = clamp
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                n.inputs[i].default_value = v
            else:
                self.L.new(v, n.inputs[i])
        return n.outputs[0]

    def mrange(self, src, f0, f1, t0=0.0, t1=1.0):
        n = self.N.new('ShaderNodeMapRange'); n.clamp = True
        self.L.new(src, n.inputs['Value'])
        n.inputs['From Min'].default_value = f0
        n.inputs['From Max'].default_value = f1
        n.inputs['To Min'].default_value = t0
        n.inputs['To Max'].default_value = t1
        return n.outputs['Result']

    def coord(self, axis):
        if not hasattr(self, '_sep'):
            tc = self.N.new('ShaderNodeTexCoord')
            self._tc = tc
            self._sep = self.N.new('ShaderNodeSeparateXYZ')
            self.L.new(tc.outputs['Object'], self._sep.inputs[0])
        if axis == 'r':
            x2 = self.math('MULTIPLY', self._sep.outputs['X'], self._sep.outputs['X'])
            y2 = self.math('MULTIPLY', self._sep.outputs['Y'], self._sep.outputs['Y'])
            return self.math('SQRT', self.math('ADD', x2, y2))
        return self._sep.outputs[axis.upper()]

    def normal_z(self):
        if not hasattr(self, '_geo'):
            self._geo = self.N.new('ShaderNodeNewGeometry')
            sep = self.N.new('ShaderNodeSeparateXYZ')
            self.L.new(self._geo.outputs['Normal'], sep.inputs[0])
            self._nz = self.math('ABSOLUTE', sep.outputs['Z'])
        return self._nz

    def aov(self, src):
        n = self.N.new('ShaderNodeOutputAOV'); n.aov_name = 'glow'
        if isinstance(src, tuple):
            n.inputs['Color'].default_value = src
        else:
            self.L.new(src, n.inputs['Color'])


def build_mask(t, spec):
    k = spec['k']
    s = spec.get('s', 1.0)
    if k == 'edge':
        bev = t.N.new('ShaderNodeBevel'); bev.samples = 8
        bev.inputs['Radius'].default_value = spec.get('r', 0.012)
        geo = t.N.new('ShaderNodeNewGeometry')
        dp = t.N.new('ShaderNodeVectorMath'); dp.operation = 'DOT_PRODUCT'
        t.L.new(bev.outputs['Normal'], dp.inputs[0]); t.L.new(geo.outputs['Normal'], dp.inputs[1])
        m = t.mrange(t.math('SUBTRACT', 1.0, dp.outputs['Value']), 0.015, 0.10)
    elif k == 'band':           # one line at coord == c
        d = t.math('ABSOLUTE', t.math('SUBTRACT', t.coord(spec['axis']), spec['c']))
        m = t.mrange(d, spec['hw'], spec['hw'] * 0.35)
    elif k == 'periodic':       # lines every 'period' along an axis
        f = t.math('FRACT', t.math('DIVIDE', t.math('ADD', t.coord(spec['axis']), spec.get('off', 0.0)),
                                   spec['period']))
        d = t.math('MULTIPLY', t.math('MINIMUM', f, t.math('SUBTRACT', 1.0, f)), spec['period'])
        m = t.mrange(d, spec['hw'], spec['hw'] * 0.35)
        if 'lo' in spec:        # only inside lo..hi of the same axis
            c = t.coord(spec['axis'])
            m = t.math('MULTIPLY', m, t.math('MULTIPLY', t.math('GREATER_THAN', c, spec['lo']),
                                             t.math('LESS_THAN', c, spec['hi'])))
    elif k == 'attr':
        a = t.N.new('ShaderNodeAttribute'); a.attribute_name = spec.get('name', 'glow')
        m = a.outputs['Fac']
    else:
        raise ValueError(k)
    faces = spec.get('faces')
    if faces == 'top':
        m = t.math('MULTIPLY', m, t.mrange(t.normal_z(), 0.55, 0.8))
    elif faces == 'side':
        m = t.math('MULTIPLY', m, t.mrange(t.normal_z(), 0.8, 0.55))
    return t.math('MULTIPLY', m, s)


def mat_surface(name, accent, base_hex=None, rough=None, metal=1.0, coat=None, masks=(), emit=1.0, glow=0.5,
                spec_level=0.5):
    m = bpy.data.materials.new(name); m.use_nodes = True
    t = NT(m)
    b = t.N.get('Principled BSDF')
    kv(b, 'Base Color', rgba(base_hex or P['gun_hex']))
    kv(b, 'Metallic', metal)
    kv(b, 'Roughness', P['gun_rough'] if rough is None else rough)
    kv(b, 'Coat Weight', P['coat'] if coat is None else coat)
    kv(b, 'Coat Roughness', 0.06)
    kv(b, 'Specular IOR Level', spec_level)
    if masks:
        terms = [build_mask(t, s) for s in masks]
        tot = terms[0]
        for x in terms[1:]:
            tot = t.math('MAXIMUM', tot, x)
        tot = t.math('MINIMUM', tot, 1.0)
        kv(b, 'Emission Color', rgba(accent))
        t.L.new(t.math('MULTIPLY', tot, emit), b.inputs['Emission Strength'])
        vm = t.N.new('ShaderNodeVectorMath'); vm.operation = 'SCALE'
        vm.inputs[0].default_value = hex_lin(accent)
        t.L.new(t.math('MULTIPLY', tot, glow), vm.inputs['Scale'])
        t.aov(vm.outputs[0])
    return m


def mat_emit(name, hexcol, strength=1.0, glow=0.6, glow_hex=None):
    m = bpy.data.materials.new(name); m.use_nodes = True
    t = NT(m)
    t.N.clear()
    out = t.N.new('ShaderNodeOutputMaterial')
    em = t.N.new('ShaderNodeEmission')
    em.inputs['Color'].default_value = rgba(hexcol)
    em.inputs['Strength'].default_value = strength
    t.L.new(em.outputs[0], out.inputs['Surface'])
    if glow > 0:
        c = hex_lin(glow_hex or hexcol)
        t.aov((c[0] * glow, c[1] * glow, c[2] * glow, 1.0))
    return m


def mat_glass(name, hexcol='#04070a'):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes.get('Principled BSDF')
    kv(b, 'Base Color', rgba(hexcol)); kv(b, 'Roughness', 0.04); kv(b, 'Metallic', 0.0)
    kv(b, 'Coat Weight', 1.0); kv(b, 'Coat Roughness', 0.02)
    return m


# ---------------------------------------------------------------- geometry helpers
ROOT = [None]


def link(ob):
    bpy.context.scene.collection.objects.link(ob)
    if ROOT[0] is not None and ob is not ROOT[0]:
        ob.parent = ROOT[0]
    return ob


def mesh_obj(name, verts, faces, mat, smooth=False, attr=None, loc=(0, 0, 0), rot=(0, 0, 0), recalc=True):
    bm = bmesh.new()
    vs = [bm.verts.new(v) for v in verts]
    for f in faces:
        try:
            bm.faces.new([vs[i] for i in f])
        except ValueError:
            pass
    if recalc:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me); bm.free()
    if attr is not None:
        a = me.attributes.new('glow', 'FLOAT', 'POINT')
        a.data.foreach_set('value', [float(x) for x in attr])
    ob = bpy.data.objects.new(name, me)
    link(ob)
    if mat:
        me.materials.append(mat)
    for p in me.polygons:
        p.use_smooth = smooth
    ob.location = loc; ob.rotation_euler = rot
    return ob


def bm_obj(name, bm, mat, smooth=False, loc=(0, 0, 0), rot=(0, 0, 0)):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me)
    link(ob)
    if mat:
        me.materials.append(mat)
    for p in me.polygons:
        p.use_smooth = smooth
    ob.location = loc; ob.rotation_euler = rot
    return ob


def box_geom(c, s):
    x, y, z = c; a, b, h = s[0] / 2, s[1] / 2, s[2] / 2
    v = [(x - a, y - b, z - h), (x + a, y - b, z - h), (x + a, y + b, z - h), (x - a, y + b, z - h),
         (x - a, y - b, z + h), (x + a, y - b, z + h), (x + a, y + b, z + h), (x - a, y + b, z + h)]
    f = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    return v, f


def box(name, c, s, mat, rot=(0, 0, 0), bevel=0.0, loc=(0, 0, 0)):
    v, f = box_geom(c, s)
    ob = mesh_obj(name, v, f, mat, loc=loc, rot=rot)
    if bevel:
        md = ob.modifiers.new('bevel', 'BEVEL'); md.width = bevel; md.segments = 3
        md.harden_normals = True
        for p in ob.data.polygons:
            p.use_smooth = True
    return ob


def boxes(name, items, mat):
    """Many boxes in one mesh: items = [(center, size), ...]."""
    V, F = [], []
    for c, s in items:
        v, f = box_geom(c, s)
        o = len(V)
        V += v
        F += [tuple(i + o for i in ff) for ff in f]
    return mesh_obj(name, V, F, mat)


def cyl(name, c, r, depth, mat, axis='Z', segs=32, smooth=True, r2=None, rot=None):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=segs, radius1=r, radius2=r if r2 is None else r2, depth=depth)
    rr = {'Z': (0, 0, 0), 'Y': (math.pi / 2, 0, 0), 'X': (0, math.pi / 2, 0)}[axis] if rot is None else rot
    ob = bm_obj(name, bm, mat, smooth=smooth, loc=c, rot=rr)
    if smooth:
        md = ob.modifiers.new('es', 'EDGE_SPLIT'); md.split_angle = math.radians(40)
    return ob


def sphere(name, c, r, mat, scale=(1, 1, 1), segs=32):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=segs // 2, radius=r)
    ob = bm_obj(name, bm, mat, smooth=True, loc=c)
    ob.scale = scale
    return ob


def torus(name, R, r, mat, loc=(0, 0, 0), rot=(0, 0, 0), segs=160, rsegs=16):
    V, F = [], []
    for i in range(segs):
        a = 2 * math.pi * i / segs
        for k in range(rsegs):
            b = 2 * math.pi * k / rsegs
            V.append(((R + r * math.cos(b)) * math.cos(a), (R + r * math.cos(b)) * math.sin(a), r * math.sin(b)))
    for i in range(segs):
        for k in range(rsegs):
            i2, k2 = (i + 1) % segs, (k + 1) % rsegs
            F.append((i * rsegs + k, i2 * rsegs + k, i2 * rsegs + k2, i * rsegs + k2))
    return mesh_obj(name, V, F, mat, smooth=True, loc=loc, rot=rot)


def lathe(name, prof, mat, segs=96, loc=(0, 0, 0), rot=(0, 0, 0), smooth=True):
    """Surface of revolution of an open profile [(r, z), ...] around Z."""
    V, F = [], []
    n = len(prof)
    for i in range(segs):
        a = 2 * math.pi * i / segs
        for r, z in prof:
            V.append((r * math.cos(a), r * math.sin(a), z))
    for i in range(segs):
        i2 = (i + 1) % segs
        for k in range(n - 1):
            F.append((i * n + k, i2 * n + k, i2 * n + k + 1, i * n + k + 1))
    return mesh_obj(name, V, F, mat, smooth=smooth, loc=loc, rot=rot)


def grid_solid(name, top, zb, mat, smooth=True, attr=None):
    """Closed block from a (n+1)x(m+1) grid of top points [(x,y,z)], flat bottom at zb."""
    n1, m1 = len(top), len(top[0])
    V = [p for row in top for p in row]
    V += [(p[0], p[1], zb) for row in top for p in row]
    off = n1 * m1
    idx = lambda i, j: i * m1 + j
    F = []
    for i in range(n1 - 1):
        for j in range(m1 - 1):
            F.append((idx(i, j), idx(i + 1, j), idx(i + 1, j + 1), idx(i, j + 1)))
            F.append((off + idx(i, j), off + idx(i, j + 1), off + idx(i + 1, j + 1), off + idx(i + 1, j)))
    per = [(i, 0) for i in range(n1)] + [(n1 - 1, j) for j in range(1, m1)] + \
          [(i, m1 - 1) for i in range(n1 - 2, -1, -1)] + [(0, j) for j in range(m1 - 2, 0, -1)]
    for a, b in zip(per, per[1:] + per[:1]):
        F.append((idx(*a), idx(*b), off + idx(*b), off + idx(*a)))
    if attr is not None:
        attr = list(attr) + [0.0] * off
    ob = mesh_obj(name, V, F, mat, smooth=smooth, attr=attr)
    if smooth:
        md = ob.modifiers.new('es', 'EDGE_SPLIT'); md.split_angle = math.radians(50)
    return ob


def area_light(name, loc, size, watts, hexcol, target):
    ld = bpy.data.lights.new(name, 'AREA')
    ld.shape = 'DISK'; ld.size = size; ld.energy = watts; ld.color = hex_lin(hexcol)
    ob = bpy.data.objects.new(name, ld)
    ob.location = loc
    bpy.context.scene.collection.objects.link(ob)
    ob.rotation_euler = (Vector(target) - ob.location).to_track_quat('-Z', 'Y').to_euler()
    return ob


def world_gradient(scene):
    w = bpy.data.worlds.new('World'); w.use_nodes = True
    scene.world = w
    N, L = w.node_tree.nodes, w.node_tree.links
    bg = N.get('Background') or N.new('ShaderNodeBackground')
    tc = N.new('ShaderNodeTexCoord')
    sep = N.new('ShaderNodeSeparateXYZ'); L.new(tc.outputs['Generated'], sep.inputs[0])
    mr = N.new('ShaderNodeMapRange'); mr.clamp = True
    L.new(sep.outputs['Z'], mr.inputs['Value'])
    mr.inputs['From Min'].default_value = -1.0; mr.inputs['From Max'].default_value = 1.0
    ramp = N.new('ShaderNodeValToRGB'); L.new(mr.outputs['Result'], ramp.inputs['Fac'])
    els = ramp.color_ramp.elements
    st = P['world_stops']
    els[0].position, els[0].color = st[0][0], rgba(st[0][1])
    els[1].position, els[1].color = st[-1][0], rgba(st[-1][1])
    for pos, col in st[1:-1]:
        e = els.new(pos); e.color = rgba(col)
    L.new(ramp.outputs['Color'], bg.inputs['Color'])
    bg.inputs['Strength'].default_value = P['world_strength']


# ---------------------------------------------------------------- scene: camera, rig, plinth
def cam_dir(az, el):
    a, e = math.radians(az), math.radians(el)
    return Vector((math.cos(e) * math.sin(a), -math.cos(e) * math.cos(a), math.sin(e)))


def setup_scene(accent, samples):
    import bl_common as B
    B._LOG = _LOG
    sc = B.clear_scene()
    B.setup_cycles(sc, P['size'], P['size'], samples=samples, transparent=True)
    sc.view_settings.view_transform = 'Standard'
    sc.cycles.max_bounces = 8
    sc.cycles.glossy_bounces = 4
    target = Vector((0, 0, P['aim_z']))
    cd = bpy.data.cameras.new('Camera'); cd.lens = P['lens']
    cam = bpy.data.objects.new('Camera', cd)
    sc.collection.objects.link(cam)
    cam.location = target + cam_dir(P['az'], P['el']) * P['dist']
    cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
    sc.camera = cam
    world_gradient(sc)
    az, t0 = P['az'], (0, 0, 0.45)
    area_light('Key', tuple(cam_dir(az - 55, 48) * 6.0), 3.0, P['key_w'], '#f4f5f7', t0)
    area_light('Fill', tuple(cam_dir(az + 75, 12) * 6.0), 3.0, P['fill_w'], '#a4acb5', t0)
    area_light('Rim', tuple(cam_dir(az + 160, 28) * 5.0), 2.0, P['rim_w'], mix_hex('#c8ccd2', accent, 0.35), t0)
    setup_compositor(sc)
    return sc, cam


def setup_compositor(scene):
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
    if sa.inputs.get('Type') is not None:
        sa.inputs['Type'].default_value = 'Replace Alpha'
    L.new(sock(add.outputs, 'Result'), sa.inputs['Image'])
    L.new(rl.outputs['Alpha'], sa.inputs['Alpha'])
    out = N.new('NodeGroupOutput')
    L.new(sa.outputs[0], out.inputs[0])


def plinth(accent):
    R, H = P['plinth_r'], P['plinth_h']
    top = mat_surface('PlinthTop', accent, base_hex='#121820', rough=0.42, metal=0.7, coat=0.0, spec_level=0.25, emit=0.5, glow=0.12,
                      masks=[dict(k='periodic', axis='r', period=0.2, off=0.0, hw=0.0035, s=0.55, faces='top',
                                  lo=0.15, hi=0.86),
                             dict(k='band', axis='r', c=0.92, hw=0.006, s=1.0, faces='top')])
    prof = [(0.0, 0.0), (R - 0.03, 0.0), (R, -0.012), (R + 0.004, -H * 0.5), (R - 0.02, -H), (R - 0.12, -H - 0.012),
            (0.0, -H - 0.012)]
    ob = lathe('Plinth', prof, top, segs=192, smooth=True)
    md = ob.modifiers.new('es', 'EDGE_SPLIT'); md.split_angle = math.radians(35)
    ring = mat_emit('PlinthRing', mix_hex(accent, '#ffffff', 0.15), 1.4, glow=0.9, glow_hex=accent)
    torus('PlinthRing', R - 0.012, 0.011, ring, loc=(0, 0, 0.004), segs=256)
    under = mat_emit('PlinthUnder', accent, 0.7, glow=0.6)
    torus('PlinthUnder', R - 0.14, 0.008, under, loc=(0, 0, -H - 0.014), segs=256)


def fit(scene, cam, root, clear=None, fit_w=None):
    """Uniformly scale root about its origin so its projection fits the frame box, centre it horizontally and
    (clear=) keep its lowest point at least that high above the plinth top."""
    from bpy_extras.object_utils import world_to_camera_view
    right = Vector((math.cos(math.radians(P['az'])), math.sin(math.radians(P['az'])), 0))
    frame_w = P['dist'] * 36.0 / P['lens']
    for it in range(6):
        bpy.context.view_layer.update()
        dg = bpy.context.evaluated_depsgraph_get()
        xs, ys, zs = [], [], []
        for ob in root.children_recursive:
            if ob.type not in ('MESH', 'CURVE') or ob.hide_render:
                continue
            ev = ob.evaluated_get(dg)
            me = ev.to_mesh()
            mw = ob.matrix_world
            vs = me.vertices
            step = max(1, len(vs) // 4000)
            for i in range(0, len(vs), step):
                w = mw @ vs[i].co
                v = world_to_camera_view(scene, cam, w)
                xs.append(v.x); ys.append(v.y); zs.append(w.z)
            ev.to_mesh_clear()
        w = max(xs) - min(xs); top = max(ys)
        piv = world_to_camera_view(scene, cam, root.location)
        s = min((fit_w or P['fit_w']) / w, (P['fit_top'] - piv.y) / max(1e-6, top - piv.y))
        if min(ys) < piv.y - 1e-3:
            s = min(s, (piv.y - P['fit_bottom']) / (piv.y - min(ys)))
        cx = (max(xs) + min(xs)) / 2 - 0.5
        dz = (clear - min(zs)) if clear is not None else 0.0
        log(f'  fit it{it}: w={w:.3f} top={top:.3f} bottom={min(ys):.3f} cx={cx:+.3f} minz={min(zs):.3f} -> s={s:.3f}')
        if abs(s - 1) < 0.01 and abs(cx) < 0.006 and abs(dz) < 0.005:
            break
        root.scale = root.scale * s
        root.location = root.location - right * (cx * frame_w)
        if clear is not None:
            root.location.z += dz


# ================================================================ the six objects
def build_aircraft(acc):
    """Airliner (shapes from plane_sprites.py), nose along +Y, sprite units x S."""
    S = 0.05
    gun = mat_surface('Fus', acc)
    wing = mat_surface('Wing', acc, masks=[dict(k='edge', r=0.012, s=1.0)])
    eng = mat_surface('Engine', acc, base_hex='#3a424c', rough=0.32)
    glow = mat_emit('AccLine', acc, 1.3, glow=0.7)
    glass = mat_glass('Glass')

    def capsule(name, length, radius, y0, mat, nose=1.6, tail=2.2, z=0.0):
        rings, segs = 40, 40
        V, F = [], []
        for i in range(rings + 1):
            t = i / rings
            y = y0 + t * length
            if t < 0.22:
                r = radius * (0.25 + 0.75 * math.sin(t / 0.22 * math.pi / 2) ** (1 / tail))
                zz = z + radius * 0.45 * (1 - t / 0.22) ** 1.5      # upswept tail cone
            elif t > 0.86:
                u = (t - 0.86) / 0.14
                r = radius * math.sqrt(max(0.0, 1 - u ** nose)); zz = z - radius * 0.12 * u
            else:
                r, zz = radius, z
            for k in range(segs):
                a = 2 * math.pi * k / segs
                V.append((math.cos(a) * r * S, y * S, (zz + math.sin(a) * r) * S))
        for i in range(rings):
            for k in range(segs):
                a, b = i * segs + k, i * segs + (k + 1) % segs
                F.append((a, b, b + segs, a + segs))
        F.append(tuple(range(segs - 1, -1, -1)))
        return mesh_obj(name, V, F, mat, smooth=True)

    def planform(name, pts, thick, z, mat, sweep_z=0.0):
        full = pts + [(-x, y) for x, y in reversed(pts)]
        n = len(full)
        V = [(x * S, y * S, (z - thick / 2 + sweep_z * abs(x)) * S) for x, y in full]
        V += [(x * S, y * S, (z + thick / 2 + sweep_z * abs(x)) * S) for x, y in full]
        F = [tuple(range(n - 1, -1, -1)), tuple(range(n, 2 * n))]
        F += [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
        return mesh_obj(name, V, F, mat)

    capsule('Fus', 37, 2.0, -18.5, gun)
    planform('Wing', [(1.6, 3.5), (17.0, -5.5), (17.0, -7.3), (1.6, -3.5)], 0.6, -0.6, wing, sweep_z=0.09)
    planform('Stab', [(0.8, -13.5), (6.4, -17.3), (6.4, -18.4), (0.8, -16.6)], 0.35, 1.4, wing, sweep_z=0.05)
    # fin: swept trapezoid in the YZ plane
    fp = [(-12.6, 1.4), (-15.6, 7.6), (-17.6, 7.6), (-18.0, 1.4)]
    V = [(-0.22 * S, y * S, z * S) for y, z in fp] + [(0.22 * S, y * S, z * S) for y, z in fp]
    mesh_obj('Fin', V, [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)], wing)
    # accent lines: window rows, cheat line on the fin, wingtip lights, engine intake rings
    for s in (-1, 1):
        box(f'Win{s}', (s * 1.93 * S, 1.9 * S, 0.55 * S), (0.07 * S, 22.6 * S, 0.24 * S), glow)
        x = s * 6.0
        cyl(f'Eng{s}', (x * S, 3.0 * S, -1.7 * S), 1.15 * S, 4.6 * S, eng, axis='Y')
        box(f'Pylon{s}', (x * S, 2.0 * S, -0.5 * S), (0.3 * S, 3.5 * S, 0.8 * S), eng)
        torus(f'Intake{s}', 1.08 * S, 0.12 * S, glow, loc=(x * S, 5.32 * S, -1.7 * S), rot=(math.pi / 2, 0, 0),
              segs=64, rsegs=10)
        cyl(f'Fan{s}', (x * S, 5.2 * S, -1.7 * S), 1.0 * S, 0.1 * S, mat_glass('Fan'), axis='Y')
        sphere(f'Tip{s}', (s * 17.1 * S, -6.4 * S, (-0.6 + 0.09 * 17) * S), 0.32 * S, glow, segs=16)
    sphere('Cockpit', (0, 16.4 * S, 0.75 * S), 1.0 * S, glass, scale=(1.05, 0.95, 0.5))
    box('FinLine', (0, 0, 0), (0.5 * S, 2.6 * S, 0.35 * S), glow, rot=(-0.45, 0, 0), loc=(0, -16.4 * S, 6.2 * S))
    root = ROOT[0]
    root.location = (0, 0, 0.62)
    root.rotation_euler = (math.radians(4), math.radians(-12), math.radians(150))
    return 0.22


def build_satellite(acc):
    edge = mat_surface('Bus', acc, masks=[dict(k='edge', r=0.012, s=1.0)])
    foil = mat_surface('Foil', acc, base_hex='#4a525c', rough=0.22,
                       masks=[dict(k='periodic', axis='z', period=0.12, hw=0.004, s=0.7, faces='side')])
    panel = mat_surface('Solar', acc, base_hex='#151a26', metal=0.4, rough=0.16, coat=1.0, emit=0.9, glow=0.35,
                        masks=[dict(k='periodic', axis='x', period=0.105, off=0.0, hw=0.004, s=0.75),
                               dict(k='periodic', axis='z', period=0.11, off=0.055, hw=0.004, s=0.75),
                               dict(k='edge', r=0.008, s=1.0)])
    strut = mat_surface('Strut', acc, base_hex='#3c444e')
    glow = mat_emit('SatGlow', acc, 1.3, glow=0.8)
    dishm = mat_surface('Dish', acc, base_hex='#56606c', rough=0.3,
                        masks=[dict(k='periodic', axis='r', period=0.07, hw=0.003, s=0.6)])
    # bus
    box('Bus', (0, 0, 0), (0.46, 0.46, 0.6), edge)
    box('BusBand', (0, 0, -0.05), (0.48, 0.48, 0.32), foil)
    box('TopDeck', (0, 0, 0.30), (0.36, 0.36, 0.04), edge)
    # solar wings along X, each two panels, tilted to face the camera
    for s in (-1, 1):
        cyl(f'Boom{s}', (s * 0.33, 0, 0.0), 0.018, 0.26, strut, axis='X', segs=12)
        cyl(f'Yoke{s}', (s * 0.46, 0, 0.0), 0.04, 0.05, glow, axis='X', segs=20)
        wing_items = []
        for k in range(2):
            cx = s * (0.76 + k * 0.56)
            box(f'Panel{s}{k}', (0, 0, 0), (0.52, 0.012, 0.58), panel, loc=(cx, 0, 0), rot=(math.radians(-35), 0, 0))
        cyl(f'Spar{s}', (s * 1.04, 0, 0), 0.008, 1.12, strut, axis='X', segs=8)
    # dish on the front (-Y) face, looking toward the viewer side
    prof = [(r, r * r / (4 * 0.22)) for r in [0.0, 0.03, 0.07, 0.11, 0.15, 0.19, 0.22, 0.25]]
    d = lathe('Dish', prof, dishm, segs=72, loc=(0.0, -0.28, 0.42), rot=(math.radians(-55), 0, math.radians(-20)))
    md = d.modifiers.new('sol', 'SOLIDIFY'); md.thickness = 0.012
    torus('DishRim', 0.25, 0.008, glow, loc=(0, 0, prof[-1][1]), segs=96, rsegs=8).parent = d
    cyl('Feed', (0, 0, 0.13), 0.01, 0.26, strut, segs=8).parent = d
    sphere('FeedTip', (0, 0, 0.26), 0.022, glow, segs=16).parent = d
    cyl('DishMast', (0.0, -0.2, 0.33), 0.025, 0.14, strut, segs=12)
    # small antennas and thruster
    cyl('Ant', (0.12, 0.12, 0.42), 0.008, 0.2, strut, segs=8)
    sphere('AntTip', (0.12, 0.12, 0.52), 0.016, glow, segs=12)
    cyl('Nozzle', (0, 0, -0.33), 0.06, 0.1, strut, segs=24, r2=0.035)
    root = ROOT[0]
    root.location = (0, 0, 0.75)
    root.rotation_euler = (math.radians(6), 0, math.radians(-12))
    return 0.22


def build_ship(acc):
    L2, Bw, Dk = 1.0, 0.17, 0.17           # half length, half beam, deck height (keel at 0)
    hullm = mat_surface('Hull', acc, base_hex='#4c5560',
                        masks=[dict(k='band', axis='z', c=0.055, hw=0.006, s=1.0, faces='side'),
                               dict(k='band', axis='z', c=Dk - 0.012, hw=0.004, s=0.8, faces='side')])
    deckm = mat_surface('Deck', acc, base_hex='#2a3038', rough=0.4)
    NY, K = 48, 10
    V, F = [], []
    for i in range(NY + 1):
        y = -L2 + 2 * L2 * i / NY
        u = (y - 0.45) / (L2 - 0.45)
        if u > 0:
            f = max(0.03, math.sqrt(max(0.0, 1 - u ** 2.2)))
            zk = 0.10 * u ** 1.6
        else:
            f, zk = 1.0, 0.0
        if y < -0.85:
            f *= 1 - 0.25 * ((-0.85 - y) / 0.15) ** 2
            zk = 0.07 * ((-0.85 - y) / 0.15) ** 1.5
        ring = []
        for k in range(K + 1):
            t = (math.pi / 2) * k / K
            x = Bw * f * math.sin(t) ** 0.35
            z = zk + (Dk - zk) * (1 - math.cos(t) ** 0.35) if k < K else Dk
            ring.append((x, z))
        pts = ring + [(-x, z) for x, z in reversed(ring[1:])]
        V += [(x, y, z) for x, z in pts]
    n = 2 * K + 1
    for i in range(NY):
        for k in range(n):
            a, b = i * n + k, i * n + (k + 1) % n
            F.append((a, b, b + n, a + n))
    F.append(tuple(range(n)))
    F.append(tuple(range(NY * n + n - 1, NY * n - 1, -1)))
    hull = mesh_obj('Hull', V, F, hullm, smooth=True)
    md = hull.modifiers.new('es', 'EDGE_SPLIT'); md.split_angle = math.radians(60)
    # containers: bays along Y, 5 rows across, 1..4 tiers
    tones = ['#59636f', '#46505b', '#6b7480']
    cmats = [mat_surface(f'Box{i}', acc, base_hex=h, rough=0.34, coat=0.4, emit=1.0, glow=0.35,
                         masks=[dict(k='edge', r=0.006, s=1.0)]) for i, h in enumerate(tones)]
    groups = [[], [], []]
    cw, cl, ch, gap = 0.062, 0.135, 0.052, 0.006
    tiers = [2, 3, 4, 4, 4, 3, 4, 3, 2]
    y0 = -0.56
    rnd = 7
    for b, nt in enumerate(tiers):
        y = y0 + b * (cl + gap)
        for c in range(5):
            x = (c - 2) * (cw + gap)
            if c in (0, 4) and b == len(tiers) - 1:
                continue
            hmax = nt - (1 if c in (0, 4) and b == 0 else 0)
            for t in range(hmax):
                rnd = (rnd * 1103515245 + 12345) & 0x7fffffff
                groups[rnd % 3].append(((x, y, Dk + ch / 2 + t * (ch + 0.002)), (cw, cl, ch)))
    for i, g in enumerate(groups):
        boxes(f'Containers{i}', g, cmats[i])
    # superstructure at the stern with a glowing window band, funnel, bow mast
    sup = mat_surface('Bridge', acc, base_hex='#6c7581', masks=[dict(k='edge', r=0.006, s=0.8)])
    glow = mat_emit('ShipGlow', acc, 1.3, glow=0.8)
    box('Bridge0', (0, -0.78, Dk + 0.07), (0.3, 0.12, 0.14), sup)
    box('Bridge1', (0, -0.78, Dk + 0.18), (0.36, 0.1, 0.08), sup)
    box('BridgeWin', (0, -0.729, Dk + 0.19), (0.34, 0.004, 0.022), glow)
    box('BridgeWin2', (0, -0.731, Dk + 0.10), (0.26, 0.004, 0.014), glow)
    cyl('Funnel', (0, -0.88, Dk + 0.13), 0.035, 0.18, sup, segs=24)
    box('FunnelBand', (0, -0.88, Dk + 0.2), (0.075, 0.075, 0.018), glow)
    cyl('Mast', (0, 0.80, Dk + 0.08), 0.008, 0.16, sup, segs=8)
    sphere('MastLight', (0, 0.80, Dk + 0.17), 0.014, glow, segs=12)
    root = ROOT[0]
    root.location = (0, 0, 0.04)
    root.rotation_euler = (0, 0, math.radians(160))
    return None


def build_quake(acc):
    n = 44
    half = 0.72

    def h(x, y):
        return (0.20 + 0.06 * math.sin(2.1 * x + 0.4) * math.cos(1.7 * y - 0.3) + 0.035 * math.sin(4.3 * x + 2.6 * y)
                + 0.02 * math.cos(7.1 * y - 3.1 * x) + 0.05 * math.exp(-((x + 0.38) ** 2 + (y - 0.3) ** 2) / 0.05))

    def fault(y):
        return 0.05 * math.sin(3.3 * y + 0.6) + 0.02 * math.sin(11.0 * y)

    terr = mat_surface('Terrain', acc, base_hex='#5a6470', rough=0.66, coat=0.08, emit=1.1, glow=0.4,
                       masks=[dict(k='periodic', axis='z', period=0.04, hw=0.0028, s=0.75, faces='top'),
                              dict(k='periodic', axis='z', period=0.045, hw=0.002, s=0.35, faces='side'),
                              dict(k='edge', r=0.01, s=1.0)])
    g = 0.022
    for side, (xa, sign, lift) in enumerate(((-half, -1, 0.0), (half, 1, 0.07))):
        top = []
        for i in range(n + 1):
            row = []
            t = i / n
            for j in range(n + 1):
                y = -half + 2 * half * j / n
                xf = fault(y) + sign * g
                x = xa + (xf - xa) * t
                row.append((x, y, h(x, y) + lift))
            top.append(row)
        grid_solid(f'Block{side}', top, 0.0 + lift * 0.0, terr, smooth=True)
    # magma in the fault gap
    crack = mat_emit('Crack', mix_hex(acc, '#ffe2c0', 0.3), 2.5, glow=1.6, glow_hex=acc)
    V, F = [], []
    m = 60
    for j in range(m + 1):
        y = -half + 2 * half * j / m
        x = fault(y)
        V += [(x - 0.016, y, 0.02), (x + 0.016, y, 0.02), (x + 0.016, y, h(x, y) - 0.01),
              (x - 0.016, y, h(x, y) - 0.01)]
    for j in range(m):
        for k in range(4):
            a, b = j * 4 + k, j * 4 + (k + 1) % 4
            F.append((a, b, b + 4, a + 4))
    mesh_obj('Crack', V, F, crack)
    # seismograph trace across the fault, rising over the tile
    wave = mat_emit('Wave', mix_hex(acc, '#fff0e0', 0.2), 1.8, glow=1.1, glow_hex=acc)
    cu = bpy.data.curves.new('Wave', 'CURVE'); cu.dimensions = '3D'
    cu.bevel_depth = 0.013; cu.bevel_resolution = 4
    sp = cu.splines.new('POLY')
    N = 170
    sp.points.add(N - 1)
    seed = 3
    for i in range(N):
        t = i / (N - 1)
        x = -0.78 + 1.56 * t
        env = 0.36 * math.exp(-((x - 0.02) / 0.2) ** 2) + 0.03 * math.exp(-((x + 0.45) / 0.12) ** 2) + 0.012
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        jit = 0.65 + 0.35 * (seed % 1000) / 1000
        z = 0.78 + env * jit * (1 if i % 2 else -1) * (0.3 if i % 4 == 0 else 1.0)
        sp.points[i].co = (x, 0.0, z, 1.0)
    ob = bpy.data.objects.new('Wave', cu); link(ob)
    cu.materials.append(wave)
    # thin baseline drop lines from the trace to the ground at both ends
    dim = mat_emit('WaveDim', acc, 0.6, glow=0.3)
    for x in (-0.78, 0.78):
        cyl(f'Drop{x}', (x, 0, 0.5), 0.004, 0.56, dim, segs=8)
    root = ROOT[0]
    root.rotation_euler = (0, 0, math.radians(14))
    return None


def build_storm(acc):
    """Hurricane: a swirled central dense overcast with a glowing eye, four swept log-spiral rain bands (each with a
    glowing crest line), and emissive particle specks riding the bands."""
    cloud = mat_surface('Cloud', acc, base_hex='#6c7682', rough=0.38, coat=0.35, emit=1.25, glow=0.55,
                        masks=[dict(k='attr', s=1.0)])
    re, Rc = 0.085, 0.40
    NR, NS = 40, 240
    V, F, A = [], [], []

    def cdo_h(r, th):
        u = (r - re) / (Rc - re)
        swirl = 0.5 + 0.5 * math.cos(4 * (th + 2.2 * math.log(max(r, 1e-3) / 0.22)))
        return 0.02 + 0.16 * math.sin(min(1.0, u * 3.0) * math.pi / 2) * (1 - u) ** 0.9 * (0.8 + 0.2 * swirl)

    for side in (0, 1):
        for i in range(NR + 1):
            r = re + (Rc - re) * i / NR
            for j in range(NS):
                th = 2 * math.pi * j / NS
                hh = cdo_h(r, th)
                if side == 0:
                    V.append((r * math.cos(th), r * math.sin(th), hh))
                    A.append(math.exp(-((r - re) / 0.02) ** 2))
                else:
                    V.append((r * math.cos(th), r * math.sin(th), -0.03 * (1 - (r - re) / (Rc - re))))
                    A.append(0.0)
    off = (NR + 1) * NS
    idx = lambda i, j: i * NS + j % NS
    for i in range(NR):
        for j in range(NS):
            F.append((idx(i, j), idx(i + 1, j), idx(i + 1, j + 1), idx(i, j + 1)))
            F.append((off + idx(i, j), off + idx(i, j + 1), off + idx(i + 1, j + 1), off + idx(i + 1, j)))
    for j in range(NS):
        F.append((idx(0, j), idx(0, j + 1), off + idx(0, j + 1), off + idx(0, j)))
        F.append((idx(NR, j), off + idx(NR, j), off + idx(NR, j + 1), idx(NR, j + 1)))
    mesh_obj('CDO', V, F, cloud, smooth=True, attr=A)

    # spiral bands
    arms, r0, pitch = 4, 0.2, 2.1
    seed = 11
    specks = []
    for a in range(arms):
        th0 = 2 * math.pi * a / arms
        NT, NP = 110, 18
        V, F, A = [], [], []
        for i in range(NT + 1):
            t = i / NT
            r = r0 + (0.86 + 0.08 * (a % 2)) * t
            th = th0 + pitch * math.log(r / r0)
            r2 = r + 1e-3
            th2 = th0 + pitch * math.log(r2 / r0)
            cx, cy = r * math.cos(th), r * math.sin(th)
            tx, ty = r2 * math.cos(th2) - cx, r2 * math.sin(th2) - cy
            tl = math.hypot(tx, ty); tx, ty = tx / tl, ty / tl
            nx, ny = -ty, tx
            w = 0.14 * (1 - t) ** 0.75 + 0.01
            h = 0.085 * (1 - t) ** 1.1 + 0.006
            zc = 0.03 * (1 - t)
            for k in range(NP):
                ph = 2 * math.pi * k / NP
                c, sn = math.cos(ph), math.sin(ph)
                z = zc + (h * sn if sn > 0 else 0.4 * h * sn)
                V.append((cx + nx * w * c, cy + ny * w * c, z))
                crest = math.exp(-((ph - math.pi / 2) / 0.32) ** 2)
                A.append(crest * min(1.0, 0.25 + t * 5) * (1 - t) ** 0.25)
            # particle specks scattered over this band
            if i % 2 == 0 and t < 0.92:
                for _ in range(3):
                    seed = (seed * 1103515245 + 12345) & 0x7fffffff
                    q = (seed % 2000) / 1000 - 1
                    seed = (seed * 1103515245 + 12345) & 0x7fffffff
                    lift = (seed % 1000) / 1000
                    if abs(q) > 0.95:
                        continue
                    specks.append((cx + nx * w * q * 1.25, cy + ny * w * q * 1.25,
                                   zc + h * math.sqrt(max(0.0, 1 - q * q)) + 0.008 + 0.03 * lift,
                                   0.004 + 0.006 * ((seed >> 8) % 100) / 100))
        for i in range(NT):
            for k in range(NP):
                p0, p1 = i * NP + k, i * NP + (k + 1) % NP
                F.append((p0, p1, p1 + NP, p0 + NP))
        F.append(tuple(range(NP)))
        F.append(tuple(range(NT * NP + NP - 1, NT * NP - 1, -1)))
        mesh_obj(f'Band{a}', V, F, cloud, smooth=True, attr=A)
    speck = mat_emit('Speck', mix_hex(acc, '#ffffff', 0.25), 1.2, glow=0.6, glow_hex=acc)
    bm = bmesh.new()
    for x, y, z, rad in specks:
        bmesh.ops.create_icosphere(bm, subdivisions=1, radius=rad, matrix=Matrix.Translation((x, y, z)))
    bm_obj('Specks', bm, speck, smooth=True)
    core = mat_emit('Eye', mix_hex(acc, '#fff6d8', 0.35), 1.8, glow=1.0, glow_hex=acc)
    cyl('EyeCore', (0, 0, -0.02), re * 0.95, 0.02, core, segs=48)
    root = ROOT[0]
    root.location = (0, 0, 0.42)
    right = Vector((math.cos(math.radians(P['az'])), math.sin(math.radians(P['az'])), 0))
    root.rotation_mode = 'QUATERNION'
    root.rotation_quaternion = Quaternion(right, math.radians(16)) @ Quaternion((0, 0, 1), math.radians(20))
    return 0.16


def build_camera(acc):
    edge = mat_surface('Housing', acc, base_hex='#5f6975',
                       masks=[dict(k='edge', r=0.01, s=1.0)])
    body = mat_surface('Body', acc, base_hex='#5f6975')
    dark = mat_surface('Dark', acc, base_hex='#2c333b', rough=0.35)
    glow = mat_emit('CamGlow', acc, 1.4, glow=0.8)
    glass = mat_glass('Lens', '#020406')
    # wall plate standing on the plinth (behind), arm reaching forward
    box('Wall', (0, 0.42, 0.48), (0.52, 0.07, 0.96), edge)
    box('WallLine', (0, 0.384, 0.3), (0.42, 0.004, 0.012), glow)
    box('Plate', (0, 0.36, 0.78), (0.2, 0.06, 0.26), edge)
    for zz in (0.7, 0.86):
        for xx in (-0.06, 0.06):
            cyl(f'Bolt{xx}{zz}', (xx, 0.326, zz), 0.012, 0.012, glow, axis='Y', segs=12)
    cyl('Arm', (0, 0.17, 0.82), 0.035, 0.36, body, axis='Y', segs=24)
    sphere('Joint', (0, -0.02, 0.82), 0.06, dark)
    cyl('Neck', (0, -0.02, 0.75), 0.03, 0.12, body, segs=20)
    # housing group, aimed out toward the viewer
    hz = 0.62
    hg = bpy.data.objects.new('HousingGroup', None); link(hg)
    hg.location = (0, -0.02, hz)
    hg.scale = (1.15, 1.15, 1.15)
    parts = []
    parts.append(box('Housing', (0, -0.18, 0), (0.25, 0.62, 0.22), body, bevel=0.05))
    parts.append(box('Hood', (0, -0.27, 0.135), (0.3, 0.6, 0.025), edge))
    for s in (-1, 1):
        parts.append(box(f'HoodSide{s}', (s * 0.142, -0.33, 0.085), (0.016, 0.4, 0.08), edge))
        parts.append(box(f'Stripe{s}', (s * 0.127, -0.18, -0.03), (0.006, 0.42, 0.014), glow))
    parts.append(cyl('LensBarrel', (0, -0.5, 0), 0.085, 0.06, dark, axis='Y', segs=40))
    parts.append(torus('LensRing', 0.088, 0.009, glow, loc=(0, -0.532, 0), rot=(math.pi / 2, 0, 0), segs=96))
    parts.append(sphere('LensGlass', (0, -0.525, 0), 0.075, glass, scale=(1, 0.35, 1), segs=40))
    for k in range(8):
        a = 2 * math.pi * k / 8
        parts.append(sphere(f'IR{k}', (0.105 * math.cos(a) * 0.0 + 0.1 * math.cos(a), -0.505, 0.1 * math.sin(a)),
                            0.008, glow, segs=10))
    parts.append(sphere('LED', (0.08, -0.47, 0.085), 0.012, glow, segs=12))
    parts.append(box('Cable', (0, 0.12, -0.02), (0.05, 0.1, 0.05), dark))
    for p in parts:
        p.parent = hg
    hg.rotation_euler = (math.radians(9), 0, math.radians(-6))
    ROOT[0].rotation_euler = (0, 0, math.radians(84))   # wall to the left, lens toward the viewer's right
    # lens glint: a 4-point star sprite on the glass, facing the camera
    star = mat_emit('Glint', '#fff4f5', 3.0, glow=1.4, glow_hex=acc)
    V = [(0, 0, 0)]
    pts = []
    for k in range(8):
        a = math.pi / 4 * k + math.pi / 4 * 0
        rr = (0.11 if k % 4 == 0 else 0.075) if k % 2 == 0 else 0.008
        pts.append((rr * math.cos(a), rr * math.sin(a), 0))
    V += pts
    F = [(0, 1 + k, 1 + (k + 1) % 8) for k in range(8)]
    g = mesh_obj('Glint', V, F, star, recalc=False)
    bpy.context.view_layer.update()
    lens_w = hg.matrix_world @ Vector((-0.035, -0.56, 0.03))
    rw = ROOT[0].matrix_world
    g.location = rw.inverted() @ lens_w                  # the glint is a child of the root
    cam = bpy.context.scene.camera
    q = cam.matrix_world.to_quaternion() @ Quaternion((0, 0, 1), math.radians(8))   # long arms ~horizontal on screen
    g.rotation_mode = 'QUATERNION'
    g.rotation_quaternion = rw.to_quaternion().inverted() @ q
    return None


BUILDERS = dict(aircraft=build_aircraft, satellite=build_satellite, ship=build_ship, quake=build_quake,
                storm=build_storm, camera=build_camera)


def render_icon(name, acc, samples):
    t0 = time.time()
    sc, cam = setup_scene(acc, samples)
    plinth(acc)
    root = bpy.data.objects.new('Root', None)
    sc.collection.objects.link(root)
    ROOT[0] = root
    clear = BUILDERS[name](acc)
    ROOT[0] = None
    fit(sc, cam, root, clear, P['fit_w_icon'].get(name))
    exr = os.path.join(WORK, f'{name}.exr')
    s = sc.render.image_settings
    s.file_format = 'OPEN_EXR'; s.color_mode = 'RGBA'; s.color_depth = '32'; s.exr_codec = 'ZIP'
    sc.render.filepath = exr
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(exr)
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    os.remove(exr)
    np.save(os.path.join(WORK, f'{name}.npy'), px.reshape(h, w, 4)[::-1].copy())
    dt = time.time() - t0
    log(f'{name}: {dt:.1f} s')
    return dt


def blender_main(argv):
    out = argv[0]
    only, post = None, True
    i = 1
    while i < len(argv):
        if argv[i] == '--only':
            only = argv[i + 1].split(','); i += 1
        elif argv[i] == '--samples':
            P['samples'] = int(argv[i + 1]); i += 1
        elif argv[i] == '--size':
            P['size'] = int(argv[i + 1]); i += 1
        elif argv[i] == '--no-post':
            post = False
        i += 1
    times = {}
    for name, acc in ICONS:
        if only and name not in only:
            continue
        try:
            times[name] = round(render_icon(name, acc, P['samples']), 1)
        except Exception:
            import traceback
            log(f'{name} FAILED\n' + traceback.format_exc())
    log('times', json.dumps(times), 'total', round(sum(times.values()), 1))
    with open(os.path.join(WORK, 'times.json'), 'w') as f:
        json.dump(times, f)
    if post:
        r = subprocess.run(['python', os.path.abspath(__file__), '--post', os.path.abspath(out)],
                           capture_output=True, text=True)
        log('post rc', r.returncode, r.stdout[-2000:], r.stderr[-2000:])


# ================================================================ post (system Python + Pillow)
def post_main(out):
    from PIL import Image, ImageDraw, ImageFont
    os.makedirs(out, exist_ok=True)
    cells, small = [], []
    rep = {}
    for name, acc in ICONS:
        p = os.path.join(WORK, f'{name}.npy')
        if not os.path.exists(p):
            continue
        u = straight_u8(*encode(np.load(p)))
        im = Image.fromarray(u, 'RGBA')
        im.save(os.path.join(out, f'{name}.png'), optimize=True)
        im.save(os.path.join(out, f'{name}.webp'), 'WEBP', quality=85, alpha_quality=90, method=6)
        ys, xs = np.where(u[..., 3] > 128)
        rep[name] = dict(bbox=[int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())],
                         edge_alpha=int(max(u[0, :, 3].max(), u[-1, :, 3].max(), u[:, 0, 3].max(), u[:, -1, 3].max())))
        cells.append((name, acc, im))
    if not cells:
        print('nothing to post'); return
    cs, gut, lab = 512, 28, 34
    sheet = Image.new('RGB', (3 * cs + 4 * gut, 2 * (cs + lab) + 3 * gut), BG)
    chk = Image.new('RGB', (3 * 180 + 4 * 12, 2 * 180 + 3 * 12), BG)
    d = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype('arial.ttf', 22)
    except Exception:
        font = ImageFont.load_default()
    for k, (name, acc, im) in enumerate(cells):
        cx, cy = k % 3, k // 3
        x, y = gut + cx * (cs + gut), gut + cy * (cs + lab + gut)
        sm = im.resize((cs, cs), Image.LANCZOS)
        sheet.paste(sm, (x, y), sm)
        d.text((x + cs // 2, y + cs + 6), name.upper(), fill=acc, font=font, anchor='mt')
        t = im.resize((180, 180), Image.LANCZOS)
        chk.paste(t, (12 + cx * 192, 12 + cy * 192), t)
    sheet.save(os.path.join(out, 'contact.png'), optimize=True)
    chk.save(os.path.join(WORK, 'check_180.png'))
    with open(os.path.join(WORK, 'post_report.json'), 'w') as f:
        json.dump(rep, f, indent=1)
    print(json.dumps(rep))


if __name__ == '__main__':
    if IN_BLENDER and '--' in sys.argv:
        argv = sys.argv[sys.argv.index('--') + 1:]
    else:
        argv = sys.argv[1:]
    out_arg = [a for a in argv if not a.startswith('--')][0]
    set_work(out_arg)
    if not IN_BLENDER or '--post' in argv:
        post_main(out_arg)
    else:
        _LOG = os.path.join(WORK, 'feature_icons.log')
        open(_LOG, 'w', encoding='utf-8').close()
        try:
            blender_main(argv)
            log('DONE')
            sys.stdout.flush()
            os._exit(0)
        except BaseException:
            import traceback
            log(traceback.format_exc())
            os._exit(1)
