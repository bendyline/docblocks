"""Write the DocBlocks brand SVGs (and the OG card's paper) from hull_lettering.

Run from the repo root:  python packages/site/design/brand/make_brand.py
Then rasterize:          node packages/site/design/brand/render-brand.mjs
And the desktop icons:   python packages/desktop/scripts/generate-icons.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageOps

from hull_lettering import Paint, icon_svg, wordmark_svg

BRAND = Path(__file__).resolve().parent
REPO = BRAND.parents[3]
SITE_IMAGES = REPO / "packages/site/public/_res/siteimages"
DESKTOP_RENDERER = REPO / "packages/desktop/renderer"

ESPRESSO = "#231F18"
PAPER = "#F4F0E6"

# The extended logo: Hull Paint. Ink faces with a tan shade on light grounds;
# on dark grounds, white faces over a black shade, exactly as on a hull.
WORDMARK_LIGHT = Paint(face=ESPRESSO, shade="#B5A985")
WORDMARK_DARK = Paint(face=PAPER, shade="#0F0D0A")
# The app icon: a single D on the espresso plate, with a tan shade so the
# depth still reads against the dark plate.
ICON_D = Paint(face=PAPER, shade="#8C7B57")


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")
    print(f"  wrote {path.relative_to(REPO).as_posix()}")


def clean_paper(src: Path, dest: Path) -> None:
    """The OG card's paper, without the old wordmark painted into it.

    The bottom third of the original base art is clean paper; mirror it up the
    card so the texture stays continuous at every seam.
    """
    base = Image.open(src).convert("RGB")
    w, h = base.size
    band_h = h // 3
    band = base.crop((0, h - band_h, w, h))
    flipped = ImageOps.flip(band)
    paper = Image.new("RGB", (w, h))
    y, use_flipped = h - band_h, False
    paper.paste(band, (0, y))
    while y > 0:
        tile = flipped if not use_flipped else band
        y -= band_h
        paper.paste(tile, (0, y))
        use_flipped = not use_flipped
    paper.save(dest, "PNG", optimize=True)
    print(f"  wrote {dest.relative_to(REPO).as_posix()}")


def main() -> None:
    light = wordmark_svg(["DOC", "BLOCKS"], WORDMARK_LIGHT)
    dark = wordmark_svg(["DOC", "BLOCKS"], WORDMARK_DARK)
    for folder in (SITE_IMAGES, DESKTOP_RENDERER):
        write(folder / "docblocks.svg", light)
        write(folder / "docblocks-dark.svg", dark)

    # docb.lk keeps its own lockup; the period is part of the address.
    write(BRAND / "docblk.svg", wordmark_svg(["DOC", "B.LK"], WORDMARK_LIGHT, title="docb.lk"))

    write(BRAND / "app-icon.svg", icon_svg(["D"], ICON_D, ESPRESSO))
    write(BRAND / "app-icon-square.svg", icon_svg(["D"], ICON_D, ESPRESSO, radius=0))
    # Maskable icons keep their content inside the central 80% circle.
    write(BRAND / "app-icon-maskable.svg", icon_svg(["D"], ICON_D, ESPRESSO, radius=0, fill=0.5))
    # A transparent glyph, trimmed tight; generate-icons.py and the Android
    # adaptive icon add their own plate and padding.
    write(BRAND / "app-icon-glyph.svg", icon_svg(["D"], ICON_D, None, fill=0.98))

    clean_paper(REPO / "packages/site/design/ogbase.png", BRAND / "og-paper.png")


if __name__ == "__main__":
    main()
