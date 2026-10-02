"""Blender (headless): decode an OpenEXR into a float16 numpy array (H x W x 3, top row first) for make_skybox.py.
    blender-launcher -b --factory-startup --python exr_dump.py -- <in.exr> <out.npy>
(Blender is the EXR reader here; nothing else on this machine decodes half-float EXR.)"""
import sys, bpy, numpy as np
src, dst = sys.argv[sys.argv.index('--') + 1:][:2]
img = bpy.data.images.load(src)
w, h = img.size
px = np.empty(w * h * 4, np.float32); img.pixels.foreach_get(px)
px = px.reshape(h, w, 4)[::-1, :, :3]        # Blender stores rows bottom-up
np.save(dst, px.astype(np.float16))
open(dst + '.log', 'w').write(f'{w}x{h} min {px.min():.4g} max {px.max():.4g} mean {px.mean():.4g} p99 {np.percentile(px, 99):.4g} p999 {np.percentile(px, 99.9):.4g}\n')
