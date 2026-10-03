"""Animated WebP preview of the zoom clip for the README (GitHub shows it inline; the MP4 is linked).

    python make_preview.py <frames_dir> [out.webp]     (default brand/clip/zoom-preview.webp)

Every 4th frame (7.5 fps), 240 px wide, lossy WebP; keeps the file around a few MB.
"""
import sys
from pathlib import Path
from PIL import Image

src = Path(sys.argv[1])
out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).resolve().parent.parent / 'clip' / 'zoom-preview.webp'
out.parent.mkdir(parents=True, exist_ok=True)
files = sorted(src.glob('frame_*.jpg'))[::4]
frames = [Image.open(f).convert('RGB').resize((240, 427), Image.LANCZOS) for f in files]
frames[0].save(out, save_all=True, append_images=frames[1:], duration=133, loop=0, quality=55, method=6)
print(len(frames), 'frames ->', out, out.stat().st_size // 1024, 'KB')
