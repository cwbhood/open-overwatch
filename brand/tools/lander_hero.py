"""Open Overwatch - landing-page hero: the ISS over the night-side Earth, flight arcs drawing in (Blender 5.2, Cycles).

Run (Git Bash):
  "$LOCALAPPDATA/Microsoft/WindowsApps/blender-launcher.exe" -b --factory-startup --python brand/tools/lander_hero.py -- \
      [--do stills,anim] [--variants wide,tall] [--frames 1,90,180] [--pct 50] [--samples 96] [--anim-samples 40]
  --do stills  hero-wide (2560x1440) and hero-tall (1080x1920) = the last frame, as .png/.jpg/.webp in brand/lander/
  --do anim    the 1920x1080 30 fps clip (180 frames) as PNGs in <work>/anim/lander/; then encode it with
               python brand/tools/lander_hero.py --encode   (needs: pip install imageio-ffmpeg)
  --frames     spot-check frames only (check_####.png in <work>/anim/lander/), --pct renders them smaller

The globe, arcs, rings and post are globe.py's build_scene (its module body is executed without its driver), so the
look matches the start screen. Added here: the ISS (brand/models/iss.glb) parented to the camera as a forced-perspective
foreground, a key light, the sun as a rim light, slow drift + array rotation over the clip.
"""
import sys, os, math, time, shutil, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
BRAND = os.path.dirname(HERE)
OUT = os.path.join(BRAND, 'lander')
# not under AppData: the Store build of Blender is sandboxed and its writes there land in its package LocalCache
WORK = os.environ.get('OW_WORK') or os.path.join(os.path.expanduser('~'), 'open-overwatch-work')
ANIM = os.path.join(WORK, 'anim', 'lander')
ISS_GLB = os.path.join(BRAND, 'models', 'iss.glb')


def encode():
    """PNG frames -> hero-loop.mp4 (H.264) + hero-loop.webm (VP9), plus a first-frame poster."""
    import imageio_ffmpeg
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    src = os.path.join(ANIM, 'frame_%04d.png')
    common = [ff, '-y', '-framerate', '30', '-i', src, '-an']
    subprocess.run(common + ['-c:v', 'libx264', '-preset', 'slow', '-crf', '21', '-pix_fmt', 'yuv420p',
                             '-movflags', '+faststart', os.path.join(OUT, 'hero-loop.mp4')], check=True)
    subprocess.run(common + ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '34', '-row-mt', '1', '-pix_fmt', 'yuv420p',
                             os.path.join(OUT, 'hero-loop.webm')], check=True)
    from PIL import Image
    Image.open(os.path.join(ANIM, 'frame_0001.png')).convert('RGB').save(os.path.join(OUT, 'hero-poster.jpg'), quality=84)
    for f in ('hero-loop.mp4', 'hero-loop.webm', 'hero-poster.jpg'):
        print(f, os.path.getsize(os.path.join(OUT, f)))


if '--encode' in sys.argv and 'bpy' not in sys.modules:
    encode()
    sys.exit(0)

import bpy  # noqa: E402
from mathutils import Vector, Matrix, Quaternion  # noqa: E402

# ---- globe.py as a library: run its module body up to the driver lines
_gsrc = open(os.path.join(HERE, 'globe.py'), encoding='utf-8').read()
_gsrc = _gsrc[:_gsrc.index('\n_a = B.script_args()')]
G = {'__file__': os.path.join(HERE, 'globe.py'), '__name__': 'globe_lib'}
exec(compile(_gsrc, G['__file__'], 'exec'), G)
B = G['B']
G['CITIES'].update({'IST': (41.26, 28.74), 'CAI': (30.12, 31.41), 'DXB': (25.25, 55.36), 'RAM': (49.44, 7.60)})

FRAMES = 180
SHOT = dict(   # shared by both variants; *_px values are reference pixels (1920-wide composition)
    target=(8.0, -24.0), d=1.75, roll=-7.0, sun_cam=(0.78, 0.30, -0.55), dawn=1.0, dawn_ang=70.0, dawn_spread=26.0,
    day_gain=1.2, anim=True, frames=FRAMES, spin_deg=4.0, arc_t0=0.35, arc_dt=0.32, arc_draw=2.2, arc_drift=0.006,
    star_gain=0.38, glare_strength=0.6,
    arcs=[('JFK', 'LHR', '#5fd3ff', 0.72), ('YYZ', 'KEF', '#5fd3ff', 0.62), ('DOV', 'RAM', '#ffb44d', 0.58, 0.7),
          ('MAD', 'MIA', '#5fd3ff', 0.42), ('LIS', 'GRU', '#5fd3ff', 0.45), ('LHR', 'DXB', '#5fd3ff', 0.50, 0.6)],
)
VARIANTS = {
    # Earth: radius R_px, centre (cx, cy) in output px. ISS: screen centre (ix, iy) px from top-left, width iw px,
    # depth iz (scene units in front of the camera), yaw/tilt/roll in degrees.
    'wide': dict(W=1920, H=1080, still=(2560, 1440), px_scale=1.0, R_px=1650, cx=1080, cy=1080 * 0.66 + 1650,
                 rings=[(1.10, 9.0, -6.0, [0.27], 1.0), (1.32, 16.0, 4.0, [0.70], -1.0)],
                 ix=1400, iy=340, iw=720, iz=0.45, yaw=28.0, tilt=24.0, iroll=-9.0),
    'tall': dict(W=1080, H=1920, still=(1080, 1920), px_scale=1.0, R_px=1250, cx=560, cy=1920 * 0.70 + 1250,
                 rings=[(1.10, 9.0, -6.0, [0.27], 1.0)],
                 ix=545, iy=700, iw=760, iz=0.45, yaw=28.0, tilt=24.0, iroll=-9.0),
}


def parse():
    a = B.script_args()
    o = dict(do='stills', variants='wide,tall', samples=96, anim_samples=40, frames='', pct=100, tex=G['DEF_TEX'])
    i = 0
    while i < len(a):
        o[a[i].lstrip('-').replace('-', '_')] = a[i + 1]
        i += 2
    return o


def import_iss(coll):
    before = set(bpy.data.objects)
    tmp = os.path.join(WORK, 'iss_copy.glb')     # the models folder may be rewritten while we render
    os.makedirs(WORK, exist_ok=True)
    shutil.copyfile(ISS_GLB, tmp)
    bpy.ops.import_scene.gltf(filepath=tmp)
    new = [ob for ob in bpy.data.objects if ob not in before]
    for ob in new:
        for c in ob.users_collection:
            c.objects.unlink(ob)
        coll.objects.link(ob)
    B.log('ISS objects', len(new), [ob.name for ob in new if ob.parent is None])
    return new


def add_iss(sc, cfg, cam, objs):
    """Parent the ISS to the camera at screen position (ix, iy), width iw px, depth iz."""
    W, H = cfg['W'], cfg['H']
    Lmax = max(W, H)
    cd = cam.data
    F = cd.lens / 36.0 * Lmax
    z = cfg['iz']
    x = z * (cfg['ix'] - W / 2 + cd.shift_x * Lmax) / F
    y = z * ((H - cfg['iy']) - H / 2 + cd.shift_y * Lmax) / F
    s = cfg['iw'] * z / F / 109.0
    rig = bpy.data.objects.new(sc.name + '_ISSRig', None)
    sc.collection.objects.link(rig)
    rig.parent = cam
    rig.location = (x, y, -z)
    rig.scale = (s, s, s)
    R0 = Matrix(((0, 1, 0), (0, 0, 1), (1, 0, 0)))          # ISS X ram -> toward camera, Y truss -> right, Z -> up
    R = (Matrix.Rotation(math.radians(cfg['iroll']), 3, 'Z') @ Matrix.Rotation(math.radians(cfg['yaw']), 3, 'Y')
         @ Matrix.Rotation(math.radians(cfg['tilt']), 3, 'X') @ R0)
    rig.rotation_mode = 'QUATERNION'
    rig.rotation_quaternion = R.to_quaternion()
    for ob in objs:
        if ob.parent is None:
            ob.parent = rig
    # lights, in camera space: key from upper right front, sun rim from behind right, cool earthshine from below
    def lamp(name, dir_cam, strength, col, angle=0.6):
        ld = bpy.data.lights.new(sc.name + name, 'SUN')
        ld.energy = strength
        ld.color = col
        ld.angle = math.radians(angle)
        ob = bpy.data.objects.new(sc.name + name, ld)
        sc.collection.objects.link(ob)
        ob.parent = cam
        ob.rotation_mode = 'QUATERNION'
        ob.rotation_quaternion = (-Vector(dir_cam)).normalized().to_track_quat('-Z', 'Y')
        return ob
    lamp('_Key', (0.75, 0.55, 0.45), 3.0, (1.0, 0.97, 0.92))
    lamp('_Rim', SHOT['sun_cam'], 5.0, (1.0, 0.93, 0.82))
    lamp('_Earthshine', (-0.2, -1.0, 0.25), 0.35, (0.55, 0.85, 1.0), angle=8)
    # lit objects need real bounces (globe.py turns them off: everything there is emission)
    cy = sc.cycles
    cy.diffuse_bounces, cy.glossy_bounces, cy.max_bounces = 2, 2, 6
    # motion over the clip: slow drift left + yaw, arrays turn a little
    T = FRAMES - 1
    p0 = rig.location.copy()
    q0 = rig.rotation_quaternion.copy()
    for f in (1, FRAMES):
        u = (f - 1) / T - 1.0           # -1 .. 0 (the last frame is the still)
        rig.location = p0 + Vector((-0.012 * u, -0.003 * u, 0.0))
        rig.rotation_quaternion = Quaternion((0, 1, 0), math.radians(6.0 * u)) @ q0
        rig.keyframe_insert('location', frame=f)
        rig.keyframe_insert('rotation_quaternion', frame=f)
        for ob in objs:
            if ob.name.startswith('solar_'):
                ob.rotation_mode = 'XYZ'
                ob.rotation_euler = (0.0, math.radians(14.0 * u), 0.0)
                ob.keyframe_insert('rotation_euler', frame=f)
    for fc in _fcurves(rig) + [c for ob in objs for c in _fcurves(ob)]:
        for kp in fc.keyframe_points:
            kp.interpolation = 'SINE'
            kp.easing = 'EASE_OUT'


def _fcurves(ob):
    ad = ob.animation_data
    if not ad or not ad.action:
        return []
    try:
        return list(ad.action.fcurves)
    except AttributeError:   # layered actions (Blender 4.4+)
        out = []
        for layer in ad.action.layers:
            for strip in layer.strips:
                for cb in strip.channelbags:
                    out.extend(cb.fcurves)
        return out


def main():
    o = parse()
    B.clear_scene()
    first = bpy.context.scene
    scenes = {}
    names = [v for v in o['variants'].split(',') if v]
    for i, name in enumerate(names):
        cfg = dict(SHOT); cfg.update(VARIANTS[name])
        sc = first if i == 0 else bpy.data.scenes.new('lander_' + name)
        sc.name = 'lander_' + name
        G['build_scene'](sc, sc.name, cfg, dict(samples=int(o['samples']), tex=o['tex']))
        objs = import_iss(sc.collection)
        add_iss(sc, cfg, sc.camera, objs)
        scenes[name] = (sc, cfg)
    todo = o['do'].split(',')
    pct = int(o['pct'])
    if 'stills' in todo:
        os.makedirs(OUT, exist_ok=True)
        for name in names:
            sc, cfg = scenes[name]
            sc.render.resolution_x, sc.render.resolution_y = cfg['still']
            sc.render.resolution_percentage = pct
            sc.cycles.samples = int(o['samples'])
            sc.cycles.use_denoising = True
            sc.frame_set(sc.frame_end)
            base = os.path.join(OUT, 'hero-' + name)
            sc.render.filepath = base + '.png'
            t0 = time.time()
            bpy.ops.render.render(write_still=True, scene=sc.name)
            B.log('still', name, '%.1f s' % (time.time() - t0))
            G['save_formats'](sc, base)
    if 'anim' in todo:
        sc, cfg = scenes['wide']
        sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = cfg['W'], cfg['H'], pct
        sc.cycles.samples = int(o['anim_samples'])
        sc.cycles.use_denoising = True
        sc.cycles.denoiser = 'OPENIMAGEDENOISE'
        sc.cycles.seed = 0
        sc.cycles.use_animated_seed = False
        sc.render.use_persistent_data = True
        os.makedirs(ANIM, exist_ok=True)
        if o['frames']:
            for f in [int(x) for x in o['frames'].split(',')]:
                sc.frame_set(f)
                sc.render.filepath = os.path.join(ANIM, 'check_%04d.png' % f)
                t0 = time.time()
                bpy.ops.render.render(write_still=True, scene=sc.name)
                B.log('check', f, '%.1f s' % (time.time() - t0))
        else:
            sc.render.filepath = os.path.join(ANIM, 'frame_####')
            t0 = time.time()
            bpy.ops.render.render(animation=True, scene=sc.name)
            B.log('animation %d frames %.1f s' % (FRAMES, time.time() - t0))


B.run(main, os.path.join(WORK, 'lander_hero.log'))
