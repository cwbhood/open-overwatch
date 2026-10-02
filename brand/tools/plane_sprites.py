"""Top-down aircraft icon sprites for globe.html, modelled and rendered in headless Blender.

    blender-launcher.exe -b --factory-startup --python plane_sprites.py -- <out_dir>
Then (system Python, adds the layer-colour glow and writes the final 96 px PNGs):
    python plane_sprites.py --post <out_dir>

Shapes: airliner, prop, heli, fighter, heavy, tprop. Palettes: civ (white airframe, cyan glow),
mil (gunmetal airframe, amber glow), emg (white airframe, red glow). Nose points up (north).
"""
import sys, os, math

SHAPES = ['airliner', 'prop', 'heli', 'fighter', 'heavy', 'tprop']
GLOW = {'civ': (95, 211, 255), 'mil': (255, 180, 77), 'emg': (255, 77, 94)}
RAW = 256        # Blender render size
FINAL = 96       # sprite size shipped to the page


# --------------------------------------------------------------------------- post-processing (system Python)
def post(out_dir):
    from PIL import Image, ImageFilter, ImageChops
    raw = os.path.join(out_dir, 'raw')
    for shape in SHAPES:
        for pal, glow in GLOW.items():
            src = os.path.join(raw, f'{shape}_{"mil" if pal == "mil" else "civ"}.png')
            im = Image.open(src).convert('RGBA')
            a = im.split()[3]
            halo = a.filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.GaussianBlur(7))
            halo = halo.point(lambda v: int(v * 0.85))
            rim = a.filter(ImageFilter.MaxFilter(5))
            rim = ImageChops.subtract(rim, a).point(lambda v: int(v * 0.9))
            g = Image.new('RGBA', im.size, glow + (0,))
            g.putalpha(ImageChops.lighter(halo, rim))
            g.alpha_composite(im)
            g = g.resize((FINAL, FINAL), Image.LANCZOS)
            px = g.load()  # alpha hygiene: no colour where alpha is 0
            for y in range(FINAL):
                for x in range(FINAL):
                    if px[x, y][3] == 0:
                        px[x, y] = (0, 0, 0, 0)
            g.save(os.path.join(out_dir, f'{shape}_{pal}.png'))
    # contact sheet for review
    sheet = Image.new('RGBA', (FINAL * len(SHAPES), FINAL * 3), (4, 6, 10, 255))
    for i, shape in enumerate(SHAPES):
        for j, pal in enumerate(GLOW):
            sheet.alpha_composite(Image.open(os.path.join(out_dir, f'{shape}_{pal}.png')), (i * FINAL, j * FINAL))
    sheet.save(os.path.join(out_dir, 'sheet.png'))
    print('post done')


if '--post' in sys.argv:
    post(sys.argv[sys.argv.index('--post') + 1])
    sys.exit(0)

# --------------------------------------------------------------------------- modelling (Blender)
import bpy, bmesh
from mathutils import Vector
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bl_common as B

PAL = {
    'civ': {'body': '#eef2f5', 'wing': '#c9d1d8', 'engine': '#7d8b98', 'accent': '#5fd3ff', 'glass': '#0d1218', 'rotor': '#2a323b'},
    'mil': {'body': '#5a6570', 'wing': '#4a545e', 'engine': '#353c44', 'accent': '#ffb44d', 'glass': '#0d1218', 'rotor': '#22282f'},
}


def mat(name, hexcol, rough=0.38, metal=0.0):
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value = B.hex_rgba(hexcol)
    p.inputs['Roughness'].default_value = rough
    p.inputs['Metallic'].default_value = metal
    return m


def obj_from_bmesh(name, bm, material):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.data.materials.append(material)
    for f in ob.data.polygons:
        f.use_smooth = True
    return ob


def planform(name, pts, thick, z, material, bevel=0.6):
    """Flat outline (x, y) extruded to a slab with rounded edges; pts are the right half, mirrored."""
    full = pts + [(-x, y) for x, y in reversed(pts)]
    bm = bmesh.new()
    vs = [bm.verts.new((x, y, z - thick / 2)) for x, y in full]
    f = bm.faces.new(vs)
    ext = bmesh.ops.extrude_face_region(bm, geom=[f])
    for v in [e for e in ext['geom'] if isinstance(e, bmesh.types.BMVert)]:
        v.co.z += thick
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob = obj_from_bmesh(name, bm, material)
    mod = ob.modifiers.new('bevel', 'BEVEL'); mod.width = thick * bevel; mod.segments = 3
    return ob


def capsule(name, length, radius, y0, material, nose=1.6, tail=2.2, z=0.0, sx=1.0, sz=1.0):
    """Fuselage along +Y from y0, rounded nose and tapered tail."""
    bm = bmesh.new()
    rings, segs = 28, 24
    for i in range(rings + 1):
        t = i / rings
        y = y0 + t * length
        # radius profile: tapered tail (t<0.25), constant, rounded nose (t>0.85)
        if t < 0.22:
            r = radius * (0.25 + 0.75 * math.sin(t / 0.22 * math.pi / 2) ** (1 / tail))
        elif t > 0.86:
            u = (t - 0.86) / 0.14
            r = radius * math.sqrt(max(0.0, 1 - u ** nose))
        else:
            r = radius
        for k in range(segs):
            a = 2 * math.pi * k / segs
            bm.verts.new((math.cos(a) * r * sx, y, z + math.sin(a) * r * sz))
    bm.verts.ensure_lookup_table()
    for i in range(rings):
        for k in range(segs):
            a, b = i * segs + k, i * segs + (k + 1) % segs
            bm.faces.new([bm.verts[a], bm.verts[b], bm.verts[b + segs], bm.verts[a + segs]])
    bmesh.ops.contextual_create(bm, geom=[bm.verts[i] for i in range(segs)])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return obj_from_bmesh(name, bm, material)


def ellipsoid(name, loc, size, material):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=12, location=loc)
    ob = bpy.context.object; ob.name = name; ob.scale = size
    ob.data.materials.append(material)
    bpy.ops.object.shade_smooth()
    return ob


def cylinder(name, loc, radius, depth, material, axis='Y'):
    rot = (math.pi / 2, 0, 0) if axis == 'Y' else (0, 0, 0)
    bpy.ops.mesh.primitive_cylinder_add(vertices=20, radius=radius, depth=depth, location=loc, rotation=rot)
    ob = bpy.context.object; ob.name = name; ob.data.materials.append(material)
    bpy.ops.object.shade_smooth()
    return ob


def box(name, loc, size, material):
    bpy.ops.mesh.primitive_cube_add(location=loc)
    ob = bpy.context.object; ob.name = name; ob.scale = (size[0] / 2, size[1] / 2, size[2] / 2)
    ob.data.materials.append(material)
    mod = ob.modifiers.new('bevel', 'BEVEL'); mod.width = min(size) * 0.3; mod.segments = 2
    return ob


def fin(name, y_root_le, y_root_te, sweep, height, z0, material, taper=0.45, thick=0.35):
    """Swept vertical fin: root chord from y_root_te..y_root_le at z0, tip raised by height and swept back."""
    root = y_root_le - y_root_te; tip = root * taper
    pts = [(y_root_te, 0), (y_root_le, 0), (y_root_le - sweep + (root - tip) * 0.15, height), (y_root_le - sweep - tip + (root - tip) * 0.15, height)]
    bm = bmesh.new()
    vs = [bm.verts.new((-thick / 2, y, z0 + z)) for y, z in pts]
    f = bm.faces.new(vs)
    ext = bmesh.ops.extrude_face_region(bm, geom=[f])
    for v in [e for e in ext['geom'] if isinstance(e, bmesh.types.BMVert)]:
        v.co.x += thick
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob = obj_from_bmesh(name, bm, material)
    mod = ob.modifiers.new('bevel', 'BEVEL'); mod.width = thick * 0.4; mod.segments = 2
    return ob


def build(shape, pal):
    c = PAL[pal]
    M = {k: mat(f'{pal}_{k}', v, rough=0.3 if k == 'glass' else 0.42, metal=0.15 if pal == 'mil' else 0.0) for k, v in c.items()}
    if shape == 'airliner':     # A320/737-class twinjet, span ~ length
        capsule('fus', 37, 2.0, -18.5, M['body'])
        planform('wing', [(1.6, 3.5), (17.0, -5.5), (17.0, -7.3), (1.6, -3.5)], 0.6, 0.2, M['wing'])
        planform('stab', [(0.8, -13.5), (6.4, -17.3), (6.4, -18.4), (0.8, -16.6)], 0.35, 0.6, M['wing'])
        fin('fin', -12.6, -18.2, 4.2, 6.2, 1.2, M['accent'] if pal == 'civ' else M['wing'])
        for s in (-1, 1):
            cylinder(f'eng{s}', (s * 6.0, 3.0, -0.6), 1.15, 4.6, M['engine'])
        ellipsoid('glass', (0, 16.6, 0.9), (1.1, 0.9, 0.45), M['glass'])
    elif shape == 'prop':       # ATR/Dash-8-class high-wing twin turboprop
        capsule('fus', 27, 1.4, -13.5, M['body'])
        planform('wing', [(1.2, 2.2), (13.5, 1.6), (13.5, -0.6), (1.2, -0.9)], 0.5, 1.2, M['wing'])
        planform('stab', [(0.6, -10.6), (4.8, -11.2), (4.8, -12.6), (0.6, -12.6)], 0.3, 2.6, M['wing'])
        fin('fin', -9.2, -13.4, 2.6, 4.4, 0.9, M['accent'] if pal == 'civ' else M['wing'], thick=0.3)
        for s in (-1, 1):
            cylinder(f'nac{s}', (s * 4.2, 2.0, 0.9), 0.8, 5.0, M['engine'])
            cylinder(f'prop{s}', (s * 4.2, 4.6, 0.9), 2.6, 0.08, M['rotor'])
        ellipsoid('glass', (0, 12.2, 0.7), (0.8, 0.7, 0.35), M['glass'])
    elif shape == 'heli':       # Black Hawk-class
        ellipsoid('fus', (0, 1.5, 0), (1.6, 4.6, 1.4), M['body'])
        cylinder('boom', (0, -5.5, 0.6), 0.35, 8.0, M['body'])
        planform('stab', [(0.3, -8.6), (2.2, -8.9), (2.2, -9.7), (0.3, -9.6)], 0.2, 0.7, M['wing'])
        for k in range(4):
            a = math.pi / 4 + k * math.pi / 2
            ob = box(f'blade{k}', (math.cos(a) * 4.0, 1.2 + math.sin(a) * 4.0, 2.0), (8.0, 0.45, 0.08), M['rotor'])
            ob.rotation_euler.z = a
        cylinder('disc', (0, 1.2, 1.9), 8.2, 0.02, mat(f'{pal}_disc', '#8b9bab', 0.6), axis='Z').active_material.diffuse_color = (1, 1, 1, 1)
        bpy.data.objects['disc'].hide_render = True  # blades read better without a solid disc
        ellipsoid('glass', (0, 4.8, 0.6), (1.1, 1.0, 0.6), M['glass'])
        cylinder('hub', (0, 1.2, 2.0), 0.5, 0.4, M['engine'], axis='Z')
    elif shape == 'fighter':    # F-16/Eurofighter-class
        capsule('fus', 17, 0.9, -8.5, M['body'], nose=1.2)
        planform('wing', [(0.8, 2.8), (5.2, -3.2), (5.2, -4.0), (0.8, -4.2)], 0.25, 0.0, M['wing'])
        planform('stab', [(0.8, -5.6), (3.2, -7.4), (3.2, -8.1), (0.8, -7.8)], 0.2, 0.0, M['wing'])
        planform('strake', [(0.7, 5.5), (1.4, 2.8), (0.7, 2.8)], 0.15, 0.1, M['wing'])
        fin('fin', -4.0, -8.4, 2.4, 3.2, 0.5, M['wing'], taper=0.35, thick=0.2)
        ellipsoid('glass', (0, 4.6, 0.75), (0.45, 1.5, 0.4), M['glass'])
    elif shape == 'heavy':      # C-17/KC-135-class four-engine jet
        capsule('fus', 44, 2.6, -22, M['body'])
        planform('wing', [(2.0, 3.0), (24.0, -8.0), (24.0, -10.2), (2.0, -5.2)], 0.8, 1.6, M['wing'])
        planform('stab', [(0.8, -17.0), (8.4, -20.6), (8.4, -22.2), (0.8, -20.6)], 0.4, 5.6, M['wing'])
        fin('fin', -14.8, -21.8, 4.0, 7.4, 1.6, M['wing'], taper=0.6, thick=0.5)
        for s in (-1, 1):
            for x, yy in ((7.6, 2.4), (13.6, -1.0)):
                cylinder(f'eng{s}{x}', (s * x, yy, 0.3), 1.0, 4.2, M['engine'])
        ellipsoid('glass', (0, 19.8, 1.4), (1.4, 1.0, 0.5), M['glass'])
    elif shape == 'tprop':      # C-130/A400-class four-turboprop transport
        capsule('fus', 32, 2.2, -16, M['body'])
        planform('wing', [(1.8, 2.4), (20.0, 1.6), (20.0, -1.0), (1.8, -1.6)], 0.7, 1.9, M['wing'])
        planform('stab', [(0.8, -12.2), (7.0, -12.8), (7.0, -14.6), (0.8, -14.6)], 0.4, 1.8, M['wing'])
        fin('fin', -9.6, -15.4, 3.0, 6.4, 1.4, M['wing'], taper=0.6, thick=0.45)
        for s in (-1, 1):
            for x in (5.4, 10.6):
                cylinder(f'nac{s}{x}', (s * x, 2.6, 1.6), 0.8, 4.6, M['engine'])
                cylinder(f'prop{s}{x}', (s * x, 5.0, 1.6), 2.3, 0.08, M['rotor'])
        ellipsoid('glass', (0, 14.0, 1.1), (1.2, 0.9, 0.45), M['glass'])


def render_one(shape, pal, out):
    sc = B.clear_scene()
    B.setup_cycles(sc, RAW, RAW, samples=48, transparent=True)
    sc.view_settings.view_transform = 'Standard'
    w = bpy.data.worlds.new('W'); w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.55, 0.6, 0.66, 1)
    w.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.55
    sc.world = w
    build(shape, pal)
    # fit: the bounding box of everything, square ortho camera straight down
    pts = [ob.matrix_world @ Vector(c) for ob in sc.objects if ob.type == 'MESH' and not ob.hide_render for c in ob.bound_box]
    xs = [p.x for p in pts]; ys = [p.y for p in pts]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    span = max(max(xs) - min(xs), max(ys) - min(ys))
    B.add_camera(sc, (cx, cy, 100), target=(cx, cy, 0), ortho_scale=span * 1.12)
    sun = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN'))
    sun.data.energy = 3.2; sun.data.angle = math.radians(8)
    sun.rotation_euler = (math.radians(35), 0, math.radians(-35))
    sc.collection.objects.link(sun)
    B.render_still(sc, out)


def main():
    out_dir = B.script_args()[0]
    raw = os.path.join(out_dir, 'raw'); os.makedirs(raw, exist_ok=True)
    for shape in SHAPES:
        for pal in ('civ', 'mil'):
            render_one(shape, pal, os.path.join(raw, f'{shape}_{pal}.png'))


if __name__ == '__main__':  # importable from plane_models.py
    B.run(main, os.path.join(B.script_args()[0], 'sprites.log'))
