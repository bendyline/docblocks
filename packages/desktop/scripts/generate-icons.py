#!/usr/bin/env python3
"""
Generate Electron app icons from packages/site/public/_res/siteimages/docblk.webp.

Produces:
  resources/icon.png           — 1024×1024 master
  resources/icons/*.png        — Linux freedesktop icon-size set
  resources/icon.iconset/…     — intermediate macOS iconset (removed at end)
  resources/icon.icns          — macOS (via iconutil)
  resources/icon.ico           — Windows multi-resolution
  installer/sidebar.bmp        — 164×314 24-bit BMP for the NSIS welcome sidebar

The source is 642×542 (non-square) with transparent background — we centre it
on a transparent square canvas with ~10% margin for better rendering in OS
chrome (dock, taskbar, alt-tab thumbnails).

Run from the docblocks repo root: python3 packages/desktop/scripts/generate-icons.py
Pass --linux-only when iconutil is unavailable and only the Linux set is needed.
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
INSTALLER = REPO_ROOT / "packages/desktop/installer"
MARGIN_RATIO = 0.10  # 10% margin around the glyph
LINUX_ICON_SIZES = (16, 32, 48, 64, 128, 256, 512)


def square_canvas(src: Image.Image, size: int) -> Image.Image:
    """Centre `src` on a transparent square canvas of `size` pixels."""
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    inner = int(size * (1 - 2 * MARGIN_RATIO))
    scale = min(inner / src.width, inner / src.height)
    nw, nh = max(1, int(src.width * scale)), max(1, int(src.height * scale))
    resized = src.resize((nw, nh), Image.LANCZOS)
    canvas.paste(resized, ((size - nw) // 2, (size - nh) // 2), resized)
    return canvas


def main(*, linux_only: bool = False) -> int:
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

    # 2) Linux freedesktop icon set. A lone 1024px image is not discoverable
    # through every hicolor theme index, which leaves some app launchers with a
    # generic icon. electron-builder installs each of these in the matching
    # hicolor size directory for both AppImage and native package targets.
    linux_icons = RESOURCES / "icons"
    linux_icons.mkdir(parents=True, exist_ok=True)
    for size in LINUX_ICON_SIZES:
        linux_icon_path = linux_icons / f"{size}x{size}.png"
        square_canvas(src, size).save(linux_icon_path, "PNG", optimize=True)
        print(f"  wrote {linux_icon_path.relative_to(REPO_ROOT)}")

    if linux_only:
        return 0

    # 3) macOS .icns via iconutil.
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

    # 4) Windows .ico — multi-resolution container.
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

    # 5) NSIS welcome sidebar — 164×314 24-bit BMP (no alpha, no transparency).
    # electron-builder forwards this to the NSIS MUI_WELCOMEFINISHPAGE_BITMAP
    # macro. Anything other than exactly 164×314 + 24-bit will be rejected at
    # installer compile time.
    INSTALLER.mkdir(parents=True, exist_ok=True)
    sidebar_path = INSTALLER / "sidebar.bmp"
    sidebar_w, sidebar_h = 164, 314
    # Flatten onto solid white — NSIS doesn't honour transparency in this role.
    sidebar_canvas = Image.new("RGB", (sidebar_w, sidebar_h), (255, 255, 255))
    # Centre the glyph with generous top-and-bottom padding.
    scale = min(
        (sidebar_w * 0.80) / src.width,
        (sidebar_h * 0.55) / src.height,
    )
    nw, nh = max(1, int(src.width * scale)), max(1, int(src.height * scale))
    resized = src.resize((nw, nh), Image.LANCZOS)
    offset = ((sidebar_w - nw) // 2, (sidebar_h - nh) // 3)
    # Composite RGBA over white to flatten alpha properly.
    flattened = Image.alpha_composite(
        Image.new("RGBA", (nw, nh), (255, 255, 255, 255)), resized
    ).convert("RGB")
    sidebar_canvas.paste(flattened, offset)
    sidebar_canvas.save(sidebar_path, "BMP")
    print(f"  wrote {sidebar_path.relative_to(REPO_ROOT)}")

    # 6) Sanity: show produced file sizes.
    for p in (master_path, icns_path, ico_path, sidebar_path):
        size_kb = os.path.getsize(p) / 1024
        print(f"    {p.name:14s} {size_kb:7.1f} KB")

    return 0


if __name__ == "__main__":
    args = sys.argv[1:]
    if any(arg != "--linux-only" for arg in args):
        print("Usage: generate-icons.py [--linux-only]", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(linux_only="--linux-only" in args))
