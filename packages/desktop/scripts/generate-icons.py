#!/usr/bin/env python3
"""
Generate Electron app icons from packages/site/design/brand/app-icon-glyph.png.

Produces:
  resources/icon.png           — 1024×1024 master
  resources/icons/*.png        — Linux freedesktop icon-size set
  resources/icon.iconset/…     — intermediate macOS iconset (removed at end)
  resources/icon.icns          — macOS (via iconutil, or Pillow where it is missing)
  resources/icon.icon/…        — macOS 26+ Icon Composer source (face + shade layers)
  resources/Assets.car         — that icon compiled by actool (Xcode 26+ only)
  resources/trayTemplate*.png  — macOS menu bar template image, @1x and @2x
  resources/icon.ico           — Windows multi-resolution
  installer/sidebar.bmp        — 164×314 24-bit BMP for the NSIS welcome sidebar

The source is the hull-lettered D on a transparent background (rendered by
packages/site/design/brand/render-brand.mjs). We centre it on the espresso
plate (see BACKGROUND) — a single letter with its painted shade, legible from
the 16px taskbar size up. The plate is a full square block everywhere except
the macOS .icns. macOS draws a third-party icon exactly as supplied, so that
plate is a rounded body inset on Apple's icon grid; a full-bleed plate renders
noticeably larger than its neighbours in the Dock and Launchpad.

macOS 26 and later no longer draw an .icns as supplied: anything that is not
exactly the system squircle is shrunk onto a gray plate. Assets.car carries an
Icon Composer icon instead — a full-bleed espresso fill with the D as layers —
which the system masks and lights itself; it also holds pre-rendered images
for macOS 12–15. The app's CFBundleIconName points at it, and the .icns stays
the CFBundleIconFile fallback and the DMG volume icon.

Run from the docblocks repo root: python3 packages/desktop/scripts/generate-icons.py
The macOS .icns step uses `iconutil` on macOS and Pillow's ICNS writer
elsewhere. Assets.car needs Xcode 26+'s `actool`; without it the step is
skipped and the committed catalog is kept. Pass --linux-only to emit just the
master PNG and the Linux hicolor set.
"""

from __future__ import annotations

import json
import os
import plistlib
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

REPO_ROOT = Path(__file__).resolve().parents[3]
SOURCE = REPO_ROOT / "packages/site/design/brand/app-icon-glyph.png"
# The same D as vectors: the shade path, then the face painted over it.
SOURCE_SVG = REPO_ROOT / "packages/site/design/brand/app-icon-glyph.svg"
RESOURCES = REPO_ROOT / "packages/desktop/resources"
INSTALLER = REPO_ROOT / "packages/desktop/installer"
MARGIN_RATIO = 0.19  # the D, shade included, fills the middle 62%
# Espresso plate behind the paper-white D: the brand's dark, and legible on
# light and dark OS chrome alike (dock, taskbar, alt-tab thumbnails).
BACKGROUND = (35, 31, 24, 255)
# Apple's macOS icon grid, applied ONLY to the .icns (see rounded=): a 1024px
# canvas holds an 824px body with a 185.4px corner radius, leaving a transparent
# margin on every side. Windows and Linux chrome expect a full square, so the
# plate is a solid block there.
MACOS_BODY_RATIO = 824 / 1024
MACOS_CORNER_RATIO = 185.4 / 824
# The plate is drawn this many times larger and downsampled, so its rounded
# corners are antialiased at every icns size.
MACOS_SUPERSAMPLE = 4
# The Icon Composer icon's name, which is also its bundle's basename and
# mac.extendInfo.CFBundleIconName in electron-builder.yml. Its deployment
# target matches mac.minimumSystemVersion, so the catalog carries flattened
# images for the releases that predate Icon Composer.
MACOS_ICON_NAME = "icon"
MACOS_MINIMUM_SYSTEM_VERSION = "12.0"
# Menu bar extras are template images — black plus alpha, which macOS tints
# for light, dark, and inactive menu bars — so the D goes in alone, without
# its plate, at the height of the system's own menu bar glyphs. The painted
# shade keeps a partial alpha so the letter still reads as hull lettering.
TRAY_POINTS = 16
TRAY_SHADE_ALPHA = 0.45
LINUX_ICON_SIZES = (16, 32, 48, 64, 128, 256, 512)
SVG_NS = "http://www.w3.org/2000/svg"


def square_canvas(src: Image.Image, size: int, *, rounded: bool = False) -> Image.Image:
    """Centre `src` on an espresso square canvas of `size` pixels.

    The plate is a solid square block by default (Windows/Linux). Pass
    ``rounded=True`` for the macOS icon: a rounded body inset on Apple's icon
    grid over a transparent margin, with the D sized to that body.
    """
    if rounded:
        inset = round(size * (1 - MACOS_BODY_RATIO) / 2)
        body = size - 2 * inset
        ss = MACOS_SUPERSAMPLE
        plate = Image.new("RGBA", (size * ss, size * ss), (0, 0, 0, 0))
        ImageDraw.Draw(plate).rounded_rectangle(
            (inset * ss, inset * ss, (inset + body) * ss - 1, (inset + body) * ss - 1),
            radius=round(body * MACOS_CORNER_RATIO * ss),
            fill=BACKGROUND,
        )
        # BOX averages each ss×ss block exactly; LANCZOS would ring a faint
        # halo past the plate edge into the transparent margin.
        canvas = plate.resize((size, size), Image.BOX)
    else:
        body = size
        canvas = Image.new("RGBA", (size, size), BACKGROUND)
    inner = int(body * (1 - 2 * MARGIN_RATIO))
    scale = min(inner / src.width, inner / src.height)
    nw, nh = max(1, int(src.width * scale)), max(1, int(src.height * scale))
    resized = src.resize((nw, nh), Image.LANCZOS)
    canvas.paste(resized, ((size - nw) // 2, (size - nh) // 2), resized)
    return canvas


def tray_template(src: Image.Image, size: int) -> Image.Image:
    """The D alone, full height on a transparent `size` square, as a template.

    A template image's color is ignored, so the D is black and its paint goes
    into alpha: the face at full strength, the shade at TRAY_SHADE_ALPHA, told
    apart by luma between the glyph's two fill colors.
    """
    glyph = src.crop(src.getbbox())
    shade_luma, face_luma = (_luma(path.get("fill", "")) for path in _glyph_paths())

    def weight(luma: int) -> int:
        face = min(1.0, max(0.0, (luma - shade_luma) / (face_luma - shade_luma)))
        return round(255 * (TRAY_SHADE_ALPHA + (1 - TRAY_SHADE_ALPHA) * face))

    paint = glyph.convert("L").point([weight(luma) for luma in range(256)])
    template = Image.new("RGBA", glyph.size, (0, 0, 0, 0))
    template.putalpha(ImageChops.multiply(glyph.getchannel("A"), paint))
    width = max(1, round(glyph.width * size / glyph.height))
    resized = template.resize((width, size), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(resized, ((size - width) // 2, 0))
    return canvas


def _glyph_paths() -> list[ET.Element]:
    """The glyph SVG's shade and face paths, in paint order."""
    paths = ET.parse(SOURCE_SVG).getroot().findall(f"{{{SVG_NS}}}path")
    if len(paths) != 2:
        raise SystemExit(
            f"{SOURCE_SVG.relative_to(REPO_ROOT)}: expected a shade and a face path, "
            f"found {len(paths)}"
        )
    return paths


def _luma(fill: str) -> float:
    """ITU-R 601 luma of a #rrggbb fill — the weights Pillow's "L" mode uses."""
    r, g, b = (int(fill[i : i + 2], 16) for i in (1, 3, 5))
    return (r * 299 + g * 587 + b * 114) / 1000


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

    # 3) macOS .icns. iconutil ships only with macOS; elsewhere Pillow writes
    # the same container, so the icon set can be regenerated on any platform.
    icns_path = RESOURCES / "icon.icns"
    if shutil.which("iconutil") is None:
        _write_icns_with_pillow(src, icns_path)
    else:
        _write_icns(src, icns_path)

    # 4) macOS 26+ Icon Composer icon, and the asset catalog compiled from it.
    icon_composer_path = RESOURCES / f"{MACOS_ICON_NAME}.icon"
    _write_icon_composer(icon_composer_path)
    asset_catalog_path = RESOURCES / "Assets.car"
    _compile_asset_catalog(icon_composer_path, asset_catalog_path)

    # 5) macOS menu bar template image. nativeImage.createFromPath picks up the
    # @2x sibling, and the "Template" suffix marks both as template images.
    for scale in (1, 2):
        suffix = "@2x" if scale == 2 else ""
        tray_path = RESOURCES / f"trayTemplate{suffix}.png"
        tray_template(src, TRAY_POINTS * scale).save(tray_path, "PNG", optimize=True)
        print(f"  wrote {tray_path.relative_to(REPO_ROOT)}")

    # 6) Windows .ico — multi-resolution container.
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

    # 7) NSIS welcome sidebar — 164×314 24-bit BMP (no alpha, no transparency).
    # electron-builder forwards this to the NSIS MUI_WELCOMEFINISHPAGE_BITMAP
    # macro. Anything other than exactly 164×314 + 24-bit will be rejected at
    # installer compile time.
    INSTALLER.mkdir(parents=True, exist_ok=True)
    sidebar_path = INSTALLER / "sidebar.bmp"
    sidebar_w, sidebar_h = 164, 314
    # Flatten onto the espresso plate — NSIS doesn't honour transparency in
    # this role, and the paper-white D would vanish on white.
    sidebar_canvas = Image.new("RGB", (sidebar_w, sidebar_h), BACKGROUND[:3])
    # Centre the glyph with generous top-and-bottom padding.
    scale = min(
        (sidebar_w * 0.55) / src.width,
        (sidebar_h * 0.40) / src.height,
    )
    nw, nh = max(1, int(src.width * scale)), max(1, int(src.height * scale))
    resized = src.resize((nw, nh), Image.LANCZOS)
    offset = ((sidebar_w - nw) // 2, (sidebar_h - nh) // 3)
    # Composite RGBA over the plate to flatten alpha properly.
    flattened = Image.alpha_composite(
        Image.new("RGBA", (nw, nh), BACKGROUND), resized
    ).convert("RGB")
    sidebar_canvas.paste(flattened, offset)
    sidebar_canvas.save(sidebar_path, "BMP")
    print(f"  wrote {sidebar_path.relative_to(REPO_ROOT)}")

    # 8) Sanity: show produced file sizes for whatever exists.
    for p in (master_path, icns_path, asset_catalog_path, ico_path, sidebar_path):
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


def _write_icns_with_pillow(src: Image.Image, icns_path: Path) -> None:
    """Write the .icns with Pillow where iconutil is unavailable."""
    sizes = (16, 32, 64, 128, 256, 512)
    base = square_canvas(src, 1024, rounded=True)
    base.save(
        icns_path,
        format="ICNS",
        append_images=[square_canvas(src, size, rounded=True) for size in sizes],
    )
    print(f"  wrote {icns_path.relative_to(REPO_ROOT)} (Pillow)")


def _write_icon_composer(icon_path: Path) -> None:
    """Write the Icon Composer bundle: the espresso fill and the D as layers.

    The fill is full bleed; the system applies the squircle mask and the glass
    edge. The face and shade are the glyph SVG's own paths, scaled as the D is
    on the plate. Translucency is off and the group casts no shadow, so the
    paper-white face and its painted shade read as they do everywhere else.
    The bundle opens in Icon Composer, which rewrites icon.json in its own style.
    """
    svg = ET.parse(SOURCE_SVG).getroot()
    viewport = " ".join(f'{key}="{svg.get(key)}"' for key in ("viewBox", "width", "height"))
    shade, face = _glyph_paths()
    if icon_path.exists():
        shutil.rmtree(icon_path)
    assets = icon_path / "Assets"
    assets.mkdir(parents=True)
    for name, path in (("face", face), ("shade", shade)):
        (assets / f"{name}.svg").write_text(
            f'<svg xmlns="{SVG_NS}" {viewport}>'
            f'<path fill="{path.get("fill")}" d="{path.get("d")}"/></svg>\n'
        )

    r, g, b, _ = BACKGROUND
    icon = {
        "fill": {"solid": f"srgb:{r / 255:.5f},{g / 255:.5f},{b / 255:.5f},1.00000"},
        "groups": [
            {
                # Topmost layer first.
                "layers": [
                    {
                        "image-name": f"{name}.svg",
                        "name": name,
                        "position": {
                            "scale": 1 - 2 * MARGIN_RATIO,
                            "translation-in-points": [0, 0],
                        },
                    }
                    for name in ("face", "shade")
                ],
                "shadow": {"kind": "none", "opacity": 0.5},
                "translucency": {"enabled": False, "value": 0.5},
            }
        ],
        "supported-platforms": {"squares": ["macOS"]},
    }
    (icon_path / "icon.json").write_text(json.dumps(icon, indent=2) + "\n")
    print(f"  wrote {icon_path.relative_to(REPO_ROOT)}")


def _actool_major_version() -> int | None:
    """The selected Xcode's actool major version, or None without one."""
    if shutil.which("xcrun") is None:
        return None
    result = subprocess.run(
        ["xcrun", "actool", "--version"], capture_output=True, check=False
    )
    if result.returncode != 0:
        return None
    version = plistlib.loads(result.stdout)["com.apple.actool.version"]
    return int(version["short-bundle-version"].split(".")[0])


def _compile_asset_catalog(icon_path: Path, catalog_path: Path) -> None:
    """Compile the Icon Composer bundle into Assets.car with Xcode 26+'s actool.

    Release builds ship the committed catalog, so packaging needs no Xcode.
    """
    version = _actool_major_version()
    if version is None or version < 26:
        print(
            f"  skipped {catalog_path.relative_to(REPO_ROOT)}: needs Xcode 26+ actool "
            "(kept the committed catalog)"
        )
        return
    with tempfile.TemporaryDirectory() as out:
        result = subprocess.run(
            [
                "xcrun", "actool", str(icon_path),
                "--compile", out,
                "--output-format", "human-readable-text",
                "--warnings",
                "--errors",
                "--output-partial-info-plist", str(Path(out) / "partial.plist"),
                "--app-icon", MACOS_ICON_NAME,
                "--include-all-app-icons",
                "--enable-on-demand-resources", "NO",
                "--development-region", "en",
                "--target-device", "mac",
                "--minimum-deployment-target", MACOS_MINIMUM_SYSTEM_VERSION,
                "--platform", "macosx",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        # Success prints only the list of files written; anything else is a
        # warning or error worth seeing.
        if result.returncode != 0 or ": warning:" in result.stdout or ": error:" in result.stdout:
            print(result.stdout + result.stderr, file=sys.stderr)
        if result.returncode != 0:
            raise SystemExit(f"actool failed to compile {icon_path.relative_to(REPO_ROOT)}")
        # actool also writes a reduced icon.icns; the full-size one from
        # _write_icns stays the CFBundleIconFile.
        shutil.copyfile(Path(out) / "Assets.car", catalog_path)
    print(f"  wrote {catalog_path.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    args = sys.argv[1:]
    if any(arg != "--linux-only" for arg in args):
        print("Usage: generate-icons.py [--linux-only]", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(linux_only="--linux-only" in args))
