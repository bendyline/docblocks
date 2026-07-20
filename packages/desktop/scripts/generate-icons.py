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
on a solid light-brown square plate (see BACKGROUND) with ~10% margin. The warm
plate keeps the black wordmark legible against dark OS chrome (dock, taskbar,
alt-tab thumbnails) where a transparent background left it invisible. The plate
is a full square block everywhere except the macOS/iOS .icns, which gets a
rounded squircle so it reads as native under the platform's own icon mask.

Run from the docblocks repo root: python3 packages/desktop/scripts/generate-icons.py
The macOS .icns step needs `iconutil` (macOS only); on Windows/Linux it is
skipped automatically, leaving the existing icon.icns untouched. Pass
--linux-only to emit just the master PNG and the Linux hicolor set.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw

REPO_ROOT = Path(__file__).resolve().parents[3]
SOURCE = REPO_ROOT / "packages/site/public/_res/siteimages/docblk.webp"
RESOURCES = REPO_ROOT / "packages/desktop/resources"
INSTALLER = REPO_ROOT / "packages/desktop/installer"
MARGIN_RATIO = 0.10  # 10% margin around the glyph
# Very light brown / warm beige plate behind the glyph. The source art is a
# black-on-transparent wordmark that all but disappears against dark OS chrome
# (Windows taskbar, macOS dark dock); a solid warm plate keeps it legible.
BACKGROUND = (216, 208, 199, 255)
# Rounded-rect corner radius as a fraction of the icon size, applied ONLY to
# the macOS/iOS squircle (see rounded=). Windows and Linux chrome expect a full
# square, so the plate is a solid block there.
CORNER_RADIUS_RATIO = 0.18
LINUX_ICON_SIZES = (16, 32, 48, 64, 128, 256, 512)


def square_canvas(src: Image.Image, size: int, *, rounded: bool = False) -> Image.Image:
    """Centre `src` on a light-brown square canvas of `size` pixels.

    The plate is a solid square block by default (Windows/Linux). Pass
    ``rounded=True`` for the macOS/iOS squircle, which rounds the corners over a
    transparent margin so the OS mask reads as native.
    """
    if rounded:
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        radius = int(size * CORNER_RADIUS_RATIO)
        ImageDraw.Draw(canvas).rounded_rectangle(
            (0, 0, size - 1, size - 1), radius=radius, fill=BACKGROUND
        )
    else:
        canvas = Image.new("RGBA", (size, size), BACKGROUND)
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

    # 3) macOS .icns via iconutil. iconutil ships only with macOS, so on other
    # platforms we skip this step (leaving any existing icon.icns in place) and
    # let a maintainer regenerate it on a Mac. The Windows .ico and installer
    # sidebar below do not depend on it.
    icns_path = RESOURCES / "icon.icns"
    if shutil.which("iconutil") is None:
        print(f"  skipped {icns_path.relative_to(REPO_ROOT)} (iconutil not found — run on macOS)")
    else:
        _write_icns(src, icns_path)

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

    # 6) Sanity: show produced file sizes for whatever exists.
    for p in (master_path, icns_path, ico_path, sidebar_path):
        if p.exists():
            size_kb = os.path.getsize(p) / 1024
            print(f"    {p.name:14s} {size_kb:7.1f} KB")

    return 0


def _write_icns(src: Image.Image, icns_path: Path) -> None:
    """Build the intermediate iconset and convert it to .icns via iconutil."""
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
        square_canvas(src, physical, rounded=True).save(
            iconset / name, "PNG", optimize=True
        )

    subprocess.run(
        ["iconutil", "--convert", "icns", "--output", str(icns_path), str(iconset)],
        check=True,
    )
    shutil.rmtree(iconset)
    print(f"  wrote {icns_path.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    args = sys.argv[1:]
    if any(arg != "--linux-only" for arg in args):
        print("Usage: generate-icons.py [--linux-only]", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(linux_only="--linux-only" in args))
