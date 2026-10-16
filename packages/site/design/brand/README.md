# DocBlocks brand art

The wordmark is hull-number lettering: solid block letters with 45° corner
chamfers and a hard painted shade, like the numbers on a navy hull. The app
icon is a single **D** in the same lettering on the espresso plate.

Everything here is generated, so a change to the letterforms or colors is a
parameter change, not hand-editing of paths or pixels.

| File                    | What it is                                                                 |
| ----------------------- | -------------------------------------------------------------------------- |
| `hull_lettering.py`     | The letterforms, the extruded shade, and the SVG writers                   |
| `make_brand.py`         | Writes every SVG below, the shipped wordmarks, and `og-paper.png`          |
| `render-brand.mjs`      | Rasterizes the PNG icons and renders the OG card and DMG background        |
| `app-icon.svg`          | The D on a rounded espresso plate (favicon, PWA, VS Code, iOS splash)      |
| `app-icon-square.svg`   | Full-bleed plate for platforms that mask it themselves (iOS, apple-touch)  |
| `app-icon-maskable.svg` | Full-bleed plate with the D inside the maskable safe zone                  |
| `app-icon-glyph.svg`    | The D alone, transparent; `.png` is the source for the desktop icon script |
| `docblk.svg`            | The `DOC B.LK` lockup for docb.lk — the period is part of the address      |
| `og-paper.png`          | The OG card's paper, with the old wordmark removed from `../ogbase.png`    |

The shipped wordmarks are written straight to their surfaces:
`public/_res/siteimages/docblocks.svg` and `docblocks-dark.svg` for the site,
marketing pages and mobile, and copies in `packages/desktop/renderer/`.

## Regenerating

From the repo root:

```bash
pip install shapely pillow                         # once
python packages/site/design/brand/make_brand.py    # SVG masters + wordmarks
node packages/site/design/brand/render-brand.mjs   # PNGs, OG card, DMG background
python packages/desktop/scripts/generate-icons.py  # desktop .png/.ico/.icns + NSIS sidebar
```

`render-brand.mjs` writes the favicon, the PWA and apple-touch icons, the VS
Code extension icon, the iOS app icon and splash, the Android adaptive-icon
foreground, `public/og.png`, and both DMG backgrounds.

## Knobs

In `hull_lettering.py`: `STEM`, `BAR` and `CUT` set the letter weight and the
house chamfer; `D_CUT` and `D_INNER_CUT` set the deeper chamfer that keeps the
D reading as a D at icon sizes. In `make_brand.py`: the `Paint` colors and the
shade `vector` (cap-height units; positive x and y drop the shade down-right).
