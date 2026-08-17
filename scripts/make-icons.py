#!/usr/bin/env python3
"""Generate the SaveYa Phone desktop icons from the real brand mark.

Run from repo root:
    python3 scripts/make-icons.py

The previous version DREW an icon with primitives and stamped "EP" (Eskew
Phone) under it. This one uses SaveYa's actual emblem instead — the teal mark
on its own sampled navy — so the app in the dock is the product's real
identity, not a placeholder.

Outputs:
    build/icon.png            (512x512, used by electron-builder for Windows)
    build/icon.iconset/...    (full Apple iconset)
    build/icon.icns           (compiled by iconutil, see below)
    assets/trayTemplate.png   (16x16 monochrome template — macOS tints it)
    assets/trayTemplate@2x.png(32x32)

Then:
    iconutil -c icns build/icon.iconset -o build/icon.icns
"""
from __future__ import annotations
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
BUILD = ROOT / "build"
ICONSET = BUILD / "icon.iconset"

# The mark lives with the web app; it is the same artwork the login page uses.
SOURCE_MARK = Path.home() / "saveya-phone-platform" / "public" / "saveya-mark.png"

ASSETS.mkdir(parents=True, exist_ok=True)
ICONSET.mkdir(parents=True, exist_ok=True)


def rounded(img: Image.Image, radius_ratio: float = 0.22) -> Image.Image:
    """macOS app icons are rounded squares; the source mark is a hard square."""
    img = img.convert("RGBA")
    size = img.size[0]
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [(0, 0), (size - 1, size - 1)], radius=int(size * radius_ratio), fill=255
    )
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def draw_phone_glyph(size: int, color: tuple[int, int, int, int]) -> Image.Image:
    """Monochrome handset for the menu-bar tray icon (brand-neutral on purpose:
    a template image is tinted by macOS and cannot carry colour)."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    s = size
    r1 = s * 0.18
    cx1, cy1 = s * 0.30, s * 0.30
    d.ellipse([cx1 - r1, cy1 - r1, cx1 + r1, cy1 + r1], fill=color)
    cx2, cy2 = s * 0.70, s * 0.70
    d.ellipse([cx2 - r1, cy2 - r1, cx2 + r1, cy2 + r1], fill=color)
    d.line([(cx1, cy1), (cx2, cy2)], fill=color, width=int(s * 0.14))
    return img


def main() -> None:
    if not SOURCE_MARK.exists():
        raise SystemExit(f"brand mark not found: {SOURCE_MARK}")
    mark = Image.open(SOURCE_MARK).convert("RGBA")
    if mark.size[0] != mark.size[1]:
        raise SystemExit(f"expected a square mark, got {mark.size}")

    base = rounded(mark.resize((1024, 1024), Image.LANCZOS))
    base.resize((512, 512), Image.LANCZOS).save(BUILD / "icon.png")

    for px in (16, 32, 64, 128, 256, 512, 1024):
        img = base.resize((px, px), Image.LANCZOS)
        if px <= 512:
            img.save(ICONSET / f"icon_{px}x{px}.png")
        if px >= 32:
            img.save(ICONSET / f"icon_{px // 2}x{px // 2}@2x.png")

    for px, name in ((16, "trayTemplate.png"), (32, "trayTemplate@2x.png")):
        draw_phone_glyph(px, (0, 0, 0, 255)).save(ASSETS / name)

    print(f"icons written from {SOURCE_MARK.name}")
    print("next: iconutil -c icns build/icon.iconset -o build/icon.icns")


if __name__ == "__main__":
    main()
