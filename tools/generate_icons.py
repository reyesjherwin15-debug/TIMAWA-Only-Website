#!/usr/bin/env python3
"""
generate_icons.py — TIMAWA app icons.

A proper lockup instead of flat text on colour: a dark navy tile with a soft
halo, a gradient badge holding a white "T", and the TIMAWA wordmark beneath it.

Outputs (overwrites):
    icons/icon-512.png            512  full lockup      (manifest "any")
    icons/icon-192.png            192  full lockup      (manifest "any")
    icons/icon-maskable-512.png   512  lockup, mask-safe (Android circular crop)
    icons/apple-touch-icon-180.png 180 full lockup      (iOS home screen)
    icons/favicon-32.png           32  badge only       (browser tab)

Requires: pillow, numpy   →  pip install pillow numpy
Run from the repo root:   python tools/generate_icons.py
"""

import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")

# tile
TILE_CENTER = (16, 26, 47)
TILE_EDGE = (6, 9, 17)

# badge ramp: brand blue → indigo
BADGE_STOPS = [(0.00, (0, 150, 255)), (0.55, (18, 108, 235)), (1.00, (94, 74, 255))]

WORD_COLOR = (236, 246, 255)

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\segoeuib.ttf",
    r"C:\Windows\Fonts\arialbd.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]

SS = 4  # supersampling for clean anti-aliased edges


def pick_font():
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            return path
    raise SystemExit("No bold sans-serif font found — add one to FONT_CANDIDATES.")


def diagonal_gradient(w, h, stops, angle=(1.0, 1.0)):
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    xx /= max(w - 1, 1)
    yy /= max(h - 1, 1)
    t = xx * angle[0] + yy * angle[1]
    t = (t - t.min()) / (t.max() - t.min())

    out = np.zeros((h, w, 3), dtype=np.float64)
    for i in range(len(stops) - 1):
        t0, c0 = stops[i]
        t1, c1 = stops[i + 1]
        mask = (t >= t0) & (t <= t1)
        span = (t1 - t0) or 1.0
        f = ((t[mask] - t0) / span)[:, None]
        out[mask] = np.array(c0, dtype=np.float64) * (1 - f) + np.array(c1, dtype=np.float64) * f
    out[t < stops[0][0]] = stops[0][1]
    out[t > stops[-1][0]] = stops[-1][1]
    return out


def tile_background(size):
    """Radial navy tile, faint top-right violet and film grain."""
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float64)
    xx /= size - 1
    yy /= size - 1

    r = np.sqrt((xx - 0.5) ** 2 + (yy - 0.40) ** 2) / 0.75
    r = np.clip(r, 0, 1)[:, :, None]
    base = np.array(TILE_CENTER, dtype=np.float64) * (1 - r) + np.array(TILE_EDGE, dtype=np.float64) * r

    violet = np.exp(-(((xx - 0.95) ** 2 + (yy - 0.02) ** 2) / 0.10))[:, :, None] * 0.5
    base = base * (1 - violet) + np.array((64, 48, 140), dtype=np.float64) * violet

    rng = np.random.default_rng(11)
    base = base + rng.normal(0, 2.2, (size, size, 1))

    return Image.fromarray(np.clip(base, 0, 255).round().astype(np.uint8), "RGB")


def build(size, layout="tile"):
    big = size * SS
    img = tile_background(big)

    if layout == "favicon":
        return _badge_only(img, big).resize((size, size), Image.LANCZOS)

    if layout == "maskable":
        # circular crop safety: badge only, well inside the 80% safe circle
        badge_size = big * 0.56
        off = (int((big - badge_size) / 2), int((big - badge_size) / 2))
        img = _halo(img, off, badge_size, big)
        badge = _badge(int(badge_size), badge_size, radius_ratio=0.285)
        glyph = Image.new("RGBA", badge.size, (0, 0, 0, 0))
        font = ImageFont.truetype(pick_font(), int(badge_size * 0.76))
        draw = ImageDraw.Draw(glyph)
        tb = draw.textbbox((0, 0), "T", font=font)
        draw.text(
            (badge_size / 2 - (tb[2] - tb[0]) / 2 - tb[0], badge_size * 0.49 - (tb[3] - tb[1]) / 2 - tb[1]),
            "T", font=font, fill=(255, 255, 255, 255),
        )
        badge = Image.alpha_composite(badge, glyph)
        img.paste(badge, off, badge)
        return img.resize((size, size), Image.LANCZOS)

    lock = _lockup(big)
    img.paste(lock, (0, 0), lock)

    return img.resize((size, size), Image.LANCZOS)


def _badge(size, badge_size, radius_ratio=0.30):
    """Gradient rounded square: glassy top highlight, shaded base, lit rim."""
    grad = diagonal_gradient(size, size, BADGE_STOPS, angle=(0.75, 0.45))
    badge = Image.fromarray(grad.round().astype(np.uint8), "RGB").convert("RGBA")

    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=int(size * radius_ratio), fill=255
    )
    badge.putalpha(mask)
    mask_arr = np.array(mask, dtype=np.float64) / 255.0

    # top glass highlight — soft, long falloff so no band edge shows
    gloss = Image.new("L", (size, size), 0)
    ImageDraw.Draw(gloss).ellipse(
        [-size * 0.30, -size * 1.05, size * 1.30, size * 0.92], fill=52
    )
    gloss = gloss.filter(ImageFilter.GaussianBlur(size * 0.12))
    shine = Image.new("RGBA", (size, size), (255, 255, 255, 0))
    shine.putalpha(Image.fromarray((np.array(gloss) * mask_arr).astype(np.uint8), "L"))
    badge = Image.alpha_composite(badge, shine)

    # weighted base so the badge sits on the tile instead of floating
    fade = np.linspace(0.0, 0.16, size)[:, None] ** 1.4 * mask_arr
    shade = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shade.putalpha(Image.fromarray((np.clip(fade, 0, 1) * 255).astype(np.uint8), "L"))
    badge = Image.alpha_composite(badge, shade)

    # top rim light that fades away instead of stopping mid-edge
    rim = Image.new("L", (size, size), 0)
    ImageDraw.Draw(rim).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=int(size * radius_ratio), outline=255, width=max(1, int(size * 0.012))
    )
    fade = np.clip(1.0 - (np.linspace(0, 1, size) / 0.55), 0, 1)[:, None] ** 1.6
    rim_alpha = (np.array(rim, dtype=np.float64) * fade * 0.42).astype(np.uint8)
    rim_img = Image.new("RGBA", (size, size), (255, 255, 255, 0))
    rim_img.putalpha(Image.fromarray(rim_alpha, "L"))
    badge = Image.alpha_composite(badge, rim_img)

    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(badge, (0, 0))
    return out


def _badge_only(img, big):
    holder = img.copy().convert("RGBA")
    badge_size = big * 0.80
    badge = _badge(int(badge_size), badge_size, radius_ratio=0.30)

    off = (int((big - badge_size) / 2), int((big - badge_size) / 2))
    holder = _halo(holder, off, badge_size, big)

    font_path = pick_font()
    layer = Image.new("RGBA", badge.size, (0, 0, 0, 0))
    inner = badge.size[0]
    font = ImageFont.truetype(font_path, int(inner * 0.78))
    draw = ImageDraw.Draw(layer)
    box = draw.textbbox((0, 0), "T", font=font)
    draw.text(
        (inner / 2 - (box[2] - box[0]) / 2 - box[0], inner * 0.485 - (box[3] - box[1]) / 2 - box[1]),
        "T", font=font, fill=(255, 255, 255, 255),
    )
    badge = Image.alpha_composite(badge, layer)
    holder.paste(badge, off, badge)
    return holder.convert("RGB")


def _halo(canvas, box, badge_size, big, strength=120):
    """Soft blue bloom behind a badge, blurred on the full canvas so no square edge shows."""
    glow_mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(glow_mask).rounded_rectangle(
        [box[0], box[1], box[0] + badge_size, box[1] + badge_size],
        radius=int(badge_size * 0.30),
        fill=strength,
    )
    glow_mask = glow_mask.filter(ImageFilter.GaussianBlur(badge_size * 0.13))
    glow = Image.new("RGBA", (big, big), (46, 138, 255, 0))
    glow.putalpha(glow_mask)
    return Image.alpha_composite(canvas.convert("RGBA"), glow)


def _lockup(big, maskable=False):
    """Badge + wordmark on one transparent layer the size of the canvas."""
    font_path = pick_font()
    layer = Image.new("RGBA", (big, big), (0, 0, 0, 0))

    badge_size = int(big * 0.475)
    cx, cy = big / 2, big * 0.400
    box = (int(cx - badge_size / 2), int(cy - badge_size / 2))

    layer = _halo(layer, (box[0], box[1] + int(badge_size * 0.04)), badge_size, big)

    badge = _badge(badge_size, badge_size, radius_ratio=0.285)

    # white T, optically centred inside the badge
    glyph = Image.new("RGBA", badge.size, (0, 0, 0, 0))
    font = ImageFont.truetype(font_path, int(badge_size * 0.76))
    draw = ImageDraw.Draw(glyph)
    tb = draw.textbbox((0, 0), "T", font=font)
    draw.text(
        (badge_size / 2 - (tb[2] - tb[0]) / 2 - tb[0], badge_size * 0.49 - (tb[3] - tb[1]) / 2 - tb[1]),
        "T", font=font, fill=(255, 255, 255, 255),
    )
    badge = Image.alpha_composite(badge, glyph)
    layer.paste(badge, box, badge)

    # wordmark
    label = "TIMAWA"
    tracking = big * 0.030
    font_size = int(big * 0.186)
    text = ImageDraw.Draw(layer)
    while _tracked_width(text, label, ImageFont.truetype(font_path, font_size), tracking) > big * 0.70 and font_size > 8:
        font_size -= 2
    word_font = ImageFont.truetype(font_path, font_size)

    shadow = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    _draw_tracked(shadow, label, word_font, tracking, big / 2, big * 0.712 + big * 0.006, (0, 0, 0, 170))
    shadow = shadow.filter(ImageFilter.GaussianBlur(big * 0.008))
    layer = Image.alpha_composite(layer, shadow)

    face = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    _draw_tracked(face, label, word_font, tracking, big / 2, big * 0.712, WORD_COLOR + (255,))
    layer = Image.alpha_composite(layer, face)

    return layer


def _tracked_width(draw, text, font, tracking):
    width = 0
    for ch in text:
        box = draw.textbbox((0, 0), ch, font=font)
        width += box[2] - box[0] + tracking
    return width - tracking if text else 0


def _draw_tracked(layer, text, font, tracking, center_x, top_y, fill):
    draw = ImageDraw.Draw(layer)
    x = center_x - _tracked_width(draw, text, font, tracking) / 2
    for ch in text:
        box = draw.textbbox((0, 0), ch, font=font)
        draw.text((x - box[0], top_y - box[1]), ch, font=font, fill=fill)
        x += (box[2] - box[0]) + tracking


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    jobs = [
        ("icon-512.png", 512, "tile"),
        ("icon-192.png", 192, "tile"),
        ("icon-maskable-512.png", 512, "maskable"),
        ("apple-touch-icon-180.png", 180, "tile"),
        ("favicon-32.png", 32, "favicon"),
    ]
    for name, size, layout in jobs:
        path = os.path.join(OUT_DIR, name)
        build(size, layout).save(path, "PNG", optimize=True)
        print(f"wrote {os.path.relpath(path)}  ({size}x{size}, {os.path.getsize(path)} bytes)")


if __name__ == "__main__":
    main()
