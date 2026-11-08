"""Renders test scenes for the fake camera and a spoken question for the fake microphone."""
import subprocess, sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageFilter

OUT = Path(__file__).parent / "media"
W, H = 1280, 720
rng = np.random.default_rng(3)

def shade(img):
    """photo-ish finish: soft blur, vignette, sensor noise"""
    im = Image.fromarray(np.clip(img * 255, 0, 255).astype(np.uint8))
    im = im.filter(ImageFilter.GaussianBlur(1.6))
    a = np.asarray(im).astype(np.float32) / 255
    yy, xx = np.mgrid[0:H, 0:W]
    v = 1 - 0.55 * (((xx - W / 2) / W) ** 2 + ((yy - H / 2) / H) ** 2) * 2.2
    a *= v[..., None]
    return a

def room():
    """a dim room: lit wall, open doorway into darkness, a door ajar, a chair"""
    yy, xx = np.mgrid[0:H, 0:W] / np.array([H, W])[:, None, None]
    light = 0.36 + 0.22 * np.exp(-((xx - 0.3) ** 2 / 0.08 + (yy - 0.2) ** 2 / 0.2))
    img = np.stack([light * 0.96, light * 0.93, light * 0.86], -1)
    floor = yy > 0.82
    img[floor] = (img[floor] * 0.62)
    # doorway (right) with trim and dark interior that fades with depth
    x0, x1, y0 = int(W * 0.58), int(W * 0.76), int(H * 0.12)
    img[y0 - 14:int(H * 0.86), x0 - 14:x1 + 14] *= 1.12
    interior = 0.06 + 0.05 * np.exp(-((xx - 0.63) ** 2) / 0.004) * (yy > 0.4)
    img[y0:int(H * 0.86), x0:x1] = interior[y0:int(H * 0.86), x0:x1, None] * np.array([1, 0.98, 0.95])
    # door ajar (left): slab catching light, dark gap beside it
    d0, d1 = int(W * 0.12), int(W * 0.24)
    img[int(H * 0.1):int(H * 0.86), d0:d1] = img[int(H * 0.1):int(H * 0.86), d0:d1] * 1.25
    img[int(H * 0.1):int(H * 0.86), d1:d1 + 52] = 0.045
    # chair back in the foreground, centre-left
    cx0, cx1, cy = int(W * 0.34), int(W * 0.5), int(H * 0.58)
    img[cy:, cx0:cx1] = 0.11
    img[cy:cy + 10, cx0 - 6:cx1 + 6] = 0.16
    return shade(img)

def hallway():
    yy, xx = np.mgrid[0:H, 0:W] / np.array([H, W])[:, None, None]
    vx, vy = 0.5, 0.46
    img = np.zeros((H, W, 3), np.float32)
    dx, dy = xx - vx, yy - vy
    depth = np.maximum(np.abs(dx) / 0.5, np.abs(dy) / 0.5)
    base = 0.08 + 0.42 * depth ** 0.8
    wall = np.abs(dx) > np.abs(dy) * 1.0
    base = np.where(wall, base * 0.9, np.where(dy > 0, base * 0.75, base * 1.1))
    img[:] = base[..., None] * np.array([0.95, 0.93, 0.88])
    end = (np.abs(dx) < 0.05) & (np.abs(dy) < 0.09)
    img[end] = 0.04
    return shade(img)

def write_y4m(frames, path, fps=15, seconds=6):
    raw = np.concatenate([np.clip(f * 255, 0, 255).astype(np.uint8)[None] for f in frames])
    n = fps * seconds
    seq = np.stack([raw[i * len(raw) // n] for i in range(n)])
    # gentle per-frame sensor noise
    noise = rng.normal(0, 2.2, seq.shape)
    seq = np.clip(seq.astype(np.float32) + noise, 0, 255).astype(np.uint8)
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(fps), "-i", "-", "-pix_fmt", "yuv420p", str(path)], stdin=subprocess.PIPE)
    p.communicate(seq.tobytes())

OUT.mkdir(exist_ok=True)
for name, fn in [("room", room), ("hallway", hallway)]:
    f = fn()
    Image.fromarray(np.clip(f * 255, 0, 255).astype(np.uint8)).save(OUT / f"{name}.png")
    write_y4m([f], OUT / f"{name}.y4m")

# a question, then silence (Chrome loops the file)
subprocess.run(["espeak-ng", "-v", "mb-us2", "-s", "140", "Is anyone here with us?", "-w", str(OUT / "q.wav")], check=True)
subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(OUT / "q.wav"), "-af", "adelay=1500,apad=pad_dur=14", "-ar", "48000", "-ac", "1", str(OUT / "speech.wav")], check=True)
print("ok")
