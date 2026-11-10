"""Draws the app icons in the app's own look: a black plane, a rising chart of
segmented bars in the one accent blue, with the last bar lit.

Writes the web icons (icons/) and the Android launcher icons
(android/app/src/main/res/mipmap-*).
usage: python tools/make_icons.py"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'icons'
RES = ROOT / 'android' / 'app' / 'src' / 'main' / 'res'

BG = (0, 0, 0)            # --bg0
LINE = (61, 61, 61)       # --line-strong
ACCENT = (76, 144, 240)   # --accent
HI = (138, 187, 255)      # --accent-hi
EDGE = (34, 34, 34)       # --line


def art(S, inset):
    """The chart alone, on transparent, for a square of side S. Everything sits
    inside [inset, 1 - inset] of the square."""
    layer = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    x0, x1 = S * inset, S * (1 - inset)
    top, base = S * inset, S * (1 - inset)
    span = base - top

    heights = [0.38, 0.62, 0.5, 0.88]    # in segments of the full span
    n = len(heights)
    gap = (x1 - x0) * 0.09
    w = ((x1 - x0) - gap * (n - 1)) / n
    seg = span / 8                       # one block of a segmented bar
    seg_gap = seg * 0.24
    base_y = base - span * 0.04

    glow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for i, h in enumerate(heights):
        bx = x0 + i * (w + gap)
        count = max(1, round(h * span / seg))
        lit = i == n - 1
        for k in range(count):
            y1 = base_y - k * seg - seg_gap
            y0 = y1 - (seg - seg_gap)
            # Older bars fade slightly toward the bottom-left; the last one is bright.
            colour = HI if lit else ACCENT
            alpha = 255 if lit else int(150 + 105 * (k + 1) / count)
            d.rectangle([bx, y0, bx + w, y1], fill=colour + (alpha,))
            if lit:
                gd.rectangle([bx, y0, bx + w, y1], fill=ACCENT + (200,))
    # Baseline.
    d.rectangle([x0 - gap * 0.4, base_y + seg_gap * 0.6, x1 + gap * 0.4, base_y + seg_gap * 0.6 + S * 0.008], fill=LINE + (255,))

    glow = glow.filter(ImageFilter.GaussianBlur(S * 0.035))
    return Image.alpha_composite(glow, layer)


def tile(size, shape='rounded', inset=0.22):
    """A finished icon: black plane, chart on top. shape is 'rounded' (web),
    'square' (maskable, iOS), 'circle' (Android round), or 'none' (transparent,
    for an adaptive icon's foreground)."""
    S = size * 4  # supersample, then downscale for smooth edges
    canvas = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    if shape != 'none':
        mask = Image.new('L', (S, S), 0)
        md = ImageDraw.Draw(mask)
        edge = Image.new('RGBA', (S, S), EDGE + (255,))
        plane = Image.new('RGBA', (S, S), BG + (255,))
        if shape == 'rounded':
            md.rounded_rectangle([0, 0, S - 1, S - 1], radius=S * 0.22, fill=255)
            inner = Image.new('L', (S, S), 0)
            b = S * 0.012  # a hairline edge, so black still reads on a black home screen
            ImageDraw.Draw(inner).rounded_rectangle([b, b, S - 1 - b, S - 1 - b], radius=S * 0.22 - b, fill=255)
            canvas.paste(edge, (0, 0), mask)
            canvas.paste(plane, (0, 0), inner)
        elif shape == 'circle':
            md.ellipse([0, 0, S - 1, S - 1], fill=255)
            canvas.paste(plane, (0, 0), mask)
        else:
            canvas.paste(plane, (0, 0))
    canvas = Image.alpha_composite(canvas, art(S, inset))
    return canvas.resize((size, size), Image.LANCZOS)


OUT.mkdir(exist_ok=True)
tile(192).save(OUT / 'icon-192.png')
tile(512).save(OUT / 'icon-512.png')
tile(512, 'square', inset=0.26).save(OUT / 'icon-maskable-512.png')  # inside the 80% safe zone
tile(180, 'square').convert('RGB').save(OUT / 'apple-touch-icon.png')  # iOS rounds it itself

# Android: legacy square and round icons, and an adaptive foreground (108dp
# canvas, of which a launcher shows the middle 72dp, so the art sits well in).
if RES.exists():
    for density, px in {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}.items():
        d = RES / f'mipmap-{density}'
        d.mkdir(exist_ok=True)
        tile(px, 'rounded').save(d / 'ic_launcher.png')
        tile(px, 'circle', inset=0.25).save(d / 'ic_launcher_round.png')
        tile(px * 108 // 48, 'none', inset=0.31).save(d / 'ic_launcher_foreground.png')
print('icons written')
