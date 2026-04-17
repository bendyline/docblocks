#!/usr/bin/env python3
"""
Generate Electron app icons from packages/site/public/_res/siteimages/docblk.webp.

Produces:
  resources/icon.png           — 1024×1024 master
  resources/icon.iconset/…     — intermediate macOS iconset (removed at end)
  resources/icon.icns          — macOS (via iconutil)
  resources/icon.ico           — Windows multi-resolution

The source is 642×542 (non-square) with transparent background — we centre it
on a transparent square canvas with ~10% margin for better rendering in OS
chrome (dock, taskbar, alt-tab thumbnails).

Run from the docblocks repo root: python3 packages/desktop/scripts/generate-icons.py
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[3]
SOURCE = REPO_ROOT / "packages/site/public/_res/siteimages/docblk.webp"
RESOURCES = REPO_ROOT / "packages/desktop/resources"
MARGIN_RATIO = 0.10  # 10% margin around the glyph


def square_canvas(src: Image.Image, size: int) -> Image.Image:
    """Centre `src` on a transparent square canvas of `size` pixels."""
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    inner = int(size * (1 - 2 * MARGIN_RATIO))
    scale = min(inner / src.width, inner / src.height)
    nw, nh = max(1, int(src.width * scale)), max(1, int(src.height * scale))
    resized = src.resize((nw, nh), Image.LANCZOS)
    canvas.paste(resized, ((size - nw) // 2, (size - nh) // 2), resized)
    return canvas


def main() -> int:
    if not SOURCE.exists():
        print(f"Source not found: {SOURCE}", file=sys.stderr)
        return 1
    RESOURCES.mkdir(parents=True, exist_ok=True)

    src = Image.open(SOURCE).convert("RGBA")
    print(f"Source: {SOURCE.relative_to(REPO_ROOT)} ({src.width}×{src.height})")

    # 1) icon.png @ 1024×1024 — master for Linux + electron-builder auto-gen.
    master_path = RESOURCES / "icon.png"
    square_canvas(src, 1024).save(master_path, "PNG", optimize=True)
    print(f"  wrote {master_path.relative_to(REPO_ROOT)}")

    # 2) macOS .icns via iconutil.
    iconset = RESOURCES / "icon.iconset"
    if iconset.exists():
        shutil.rmtree(iconset)
    iconset.mkdir()
    for logical, physical in [
        (16, 16),
        (16, 32),  # 16x16@2x
        (32, 32),
        (32, 64),  # 32x32@2x
        (128, 128),
        (128, 256),  # 128x128@2x
        (256, 256),
        (256, 512),  # 256x256@2x
        (512, 512),
        (512, 1024),  # 512x512@2x
    ]:
        suffix = "@2x" if physical != logical else ""
        name = f"icon_{logical}x{logical}{suffix}.png"
        square_canvas(src, physical).save(iconset / name, "PNG", optimize=True)

    icns_path = RESOURCES / "icon.icns"
    subprocess.run(
        ["iconutil", "--convert", "icns", "--output", str(icns_path), str(iconset)],
        check=True,
    )
    shutil.rmtree(iconset)
    print(f"  wrote {icns_path.relative_to(REPO_ROOT)}")

    # 3) Windows .ico — multi-resolution container.
    ico_path = RESOURCES / "icon.ico"
    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    # Build a 1024 canvas once and let PIL downscale to the requested sizes.
    base = square_canvas(src, 1024)
    base.save(
        ico_path,
        format="ICO",
        sizes=[(s, s) for s in ico_sizes],
    )
    print(f"  wrote {ico_path.relative_to(REPO_ROOT)}")

    # 4) Sanity: show produced file sizes.
    for p in (master_path, icns_path, ico_path):
        size_kb = os.path.getsize(p) / 1024
        print(f"    {p.name:12s} {size_kb:7.1f} KB")

    return 0


if __name__ == "__main__":
    sys.exit(main())
