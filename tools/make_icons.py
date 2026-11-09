"""Draws the app icons (purple-to-blue rounded tile with a rising bar chart).
usage: python tools/make_icons.py"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / 'icons'
OUT.mkdir(exist_ok=True)
PURPLE, BLUE, BG = (139, 92, 246), (96, 165, 250), (8, 12, 20)


def gradient(size):
    idx = np.arange(size)
    t = (idx[None, :] + idx[:, None]) / (2 * (size - 1))
    a, b = np.array(PURPLE), np.array(BLUE)
    return Image.fromarray((a + (b - a) * t[..., None]).round().astype(np.uint8), 'RGB')


def draw(size, maskable=False, rounded=True):
    S = size * 4  # supersample, then downscale for smooth edges
    tile = gradient(S)
    canvas = Image.new('RGBA', (S, S), BG + (255,) if maskable else (0, 0, 0, 0))
    mask = Image.new('L', (S, S), 0)
    md = ImageDraw.Draw(mask)
    if maskable or not rounded:
        md.rectangle([0, 0, S, S], fill=255)
    else:
        md.rounded_rectangle([0, 0, S - 1, S - 1], radius=S * 0.22, fill=255)
    canvas.paste(tile, (0, 0), mask)

    d = ImageDraw.Draw(canvas)
    inset = 0.24 if maskable else 0.2  # maskable art stays inside the 80% safe zone
    x0, x1 = S * inset, S * (1 - inset)
    base = S * (1 - inset)
    heights = [0.28, 0.45, 0.36, 0.62]
    n = len(heights)
    gap = (x1 - x0) * 0.08
    w = ((x1 - x0) - gap * (n - 1)) / n
    span = S * (1 - 2 * inset)
    for i, h in enumerate(heights):
        bx = x0 + i * (w + gap)
        d.rounded_rectangle([bx, base - span * h / 0.62 * 0.95, bx + w, base], radius=w * 0.22, fill=(255, 255, 255, 235))
    return canvas.resize((size, size), Image.LANCZOS)


draw(192).save(OUT / 'icon-192.png')
draw(512).save(OUT / 'icon-512.png')
draw(512, maskable=True).save(OUT / 'icon-maskable-512.png')
draw(180, rounded=False).convert('RGB').save(OUT / 'apple-touch-icon.png')  # iOS rounds it itself
print('icons written to', OUT)
