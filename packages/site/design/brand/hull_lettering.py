"""Hull-number lettering for the DocBlocks mark, drawn as vector geometry.

The wordmark reads like a navy hull number: solid block letters with 45°
corner chamfers and a hard painted shade. Letters are built on a cap height of
100 (y grows downward, as in SVG) from stems, bars and counters, then given
their corner cuts. The shade is an exact extrusion — the Minkowski sum of the
letters with the shade vector — so it reads as paint, not a blurred shadow.

Requires shapely (`pip install shapely`). See README.md for regeneration.
"""

from __future__ import annotations

from dataclasses import dataclass

from shapely import affinity
from shapely.geometry import MultiPolygon, Polygon, box
from shapely.ops import unary_union

H = 100.0  # cap height
STEM = 24.0  # vertical stroke
BAR = 19.0  # horizontal stroke
W = 76.0  # standard letter width
CUT = 10.0  # house corner chamfer

# The D's right-side chamfers run deeper than the house cut so the D reads as
# a D, not an O, at icon sizes. The counter's right corners are cut in
# parallel by D_INNER_CUT; (BAR + D_INNER_CUT) / √2 is the diagonal's weight,
# so 8 makes it exactly as heavy as a bar instead of pinching.
D_CUT = 20.0
D_INNER_CUT = 8.0

COUNTER = (STEM, BAR, W - STEM, H - BAR)


def rect(x0, y0, x1, y1):
    return box(x0, y0, x1, y1)


def corner_cut(x, y, corner, size):
    """The triangle a 45° chamfer removes at the outer corner (x, y)."""
    sx = -1 if corner in ("tr", "br") else 1
    sy = 1 if corner in ("tl", "tr") else -1
    return Polygon([(x, y), (x + sx * size, y), (x, y + sy * size)])


def glyph(ch: str) -> tuple[Polygon | MultiPolygon, float]:
    """One letter's outline and advance width."""
    w = W
    cuts: list[tuple[float, float, str]] = []
    if ch == "D":
        cx1, cy0, cy1 = COUNTER[2], COUNTER[1], COUNTER[3]
        shape = (
            rect(0, 0, w, H)
            .difference(rect(*COUNTER))
            .union(Polygon([(cx1 - D_INNER_CUT, cy0), (cx1, cy0), (cx1, cy0 + D_INNER_CUT)]))
            .union(Polygon([(cx1 - D_INNER_CUT, cy1), (cx1, cy1), (cx1, cy1 - D_INNER_CUT)]))
            .difference(corner_cut(w, 0, "tr", D_CUT))
            .difference(corner_cut(w, H, "br", D_CUT))
        )
        return shape, w
    if ch == "O":
        shape = rect(0, 0, w, H).difference(rect(*COUNTER))
        cuts = [(0, 0, "tl"), (w, 0, "tr"), (0, H, "bl"), (w, H, "br")]
    elif ch == "C":
        shape = rect(0, 0, w, H).difference(rect(STEM, BAR, w + 1, H - BAR))
        cuts = [(0, 0, "tl"), (0, H, "bl")]
    elif ch == "B":
        mid0, mid1 = H / 2 - BAR / 2, H / 2 + BAR / 2
        waist = Polygon([(w, H / 2 - CUT), (w - CUT, H / 2), (w, H / 2 + CUT)])
        shape = (
            rect(0, 0, w, H)
            .difference(rect(STEM, BAR, w - STEM, mid0))
            .difference(rect(STEM, mid1, w - STEM, H - BAR))
            .difference(waist)
        )
        cuts = [(w, 0, "tr"), (w, H, "br")]
    elif ch == "L":
        w = 66.0
        shape = unary_union([rect(0, 0, STEM, H), rect(0, H - BAR, w, H)])
    elif ch == "K":
        arm = Polygon([(STEM, 44), (49, 0), (w, 0), (STEM, 92)])
        leg = Polygon([(28, 46), (52, 46), (w, H), (52, H)])
        shape = unary_union([rect(0, 0, STEM, H), arm, leg]).intersection(rect(0, 0, w, H))
    elif ch == "S":
        mid0, mid1 = H / 2 - BAR / 2, H / 2 + BAR / 2
        shape = unary_union(
            [
                rect(0, 0, w, BAR),
                rect(0, 0, STEM, mid1),
                rect(0, mid0, w, mid1),
                rect(w - STEM, mid0, w, H),
                rect(0, H - BAR, w, H),
            ]
        )
        cuts = [(0, 0, "tl"), (w, H, "br")]
    elif ch == ".":
        w = 14.0
        shape = rect(0, H - 14, 14, H)
    else:
        raise ValueError(f"no glyph for {ch!r}")
    for x, y, corner in cuts:
        shape = shape.difference(corner_cut(x, y, corner, CUT))
    return shape, w


def extrude(shape, dx: float, dy: float):
    """Exact Minkowski sum of `shape` with the segment (0,0)→(dx,dy)."""
    parts = [shape, affinity.translate(shape, dx, dy)]
    polys = shape.geoms if isinstance(shape, MultiPolygon) else [shape]
    for poly in polys:
        for ring in [poly.exterior, *poly.interiors]:
            pts = list(ring.coords)
            for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
                quad = Polygon([(x0, y0), (x1, y1), (x1 + dx, y1 + dy), (x0 + dx, y0 + dy)])
                if quad.area > 1e-9:
                    parts.append(quad)
    return unary_union(parts)


def to_path(geom) -> str:
    polys = geom.geoms if isinstance(geom, MultiPolygon) else [geom]
    out = []
    for poly in polys:
        for ring in [poly.exterior, *poly.interiors]:
            pts = list(ring.coords)[:-1]
            out.append("M" + "L".join(f"{x:.2f} {y:.2f}" for x, y in pts) + "Z")
    return "".join(out)


@dataclass(frozen=True)
class Paint:
    """Face and shade colors, plus the shade vector in cap-height units."""

    face: str
    shade: str
    vector: tuple[float, float] = (9.0, 9.0)

    @property
    def depth(self) -> float:
        return max(abs(self.vector[0]), abs(self.vector[1]))


def letters(lines: list[str], paint: Paint):
    """Face geometry for lines of text, spaced so neighbouring shades never touch."""
    gap = 9.0 + paint.depth
    line_gap = 12.0 + paint.depth
    shapes, y = [], 0.0
    for line in lines:
        x = 0.0
        for ch in line:
            if ch == " ":
                x += 34.0
                continue
            shape, width = glyph(ch)
            shapes.append(affinity.translate(shape, x, y))
            x += width + gap
        y += H + line_gap
    return unary_union(shapes)


def wordmark_svg(lines: list[str], paint: Paint, title: str = "DocBlocks", pad: float = 6.0) -> str:
    face = letters(lines, paint)
    shade = extrude(face, *paint.vector)
    minx, miny, maxx, maxy = shade.bounds
    face = affinity.translate(face, pad - minx, pad - miny)
    shade = affinity.translate(shade, pad - minx, pad - miny)
    vw, vh = maxx - minx + 2 * pad, maxy - miny + 2 * pad
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {vw:.1f} {vh:.1f}" '
        f'width="{vw:.0f}" height="{vh:.0f}" role="img"><title>{title}</title>'
        f'<path fill="{paint.shade}" d="{to_path(shade)}"/>'
        f'<path fill="{paint.face}" d="{to_path(face)}"/></svg>\n'
    )


def icon_svg(
    lines: list[str],
    paint: Paint,
    plate: str | None,
    *,
    size: float = 1024.0,
    fill: float = 0.62,
    radius: float = 0.18,
    title: str = "DocBlocks",
) -> str:
    """A square icon: the lettering centred within `fill` of the square.

    The letters' faces are centred across, and the shade hangs off them: the
    eye reads the face as the letter, so centring the shade too would push
    the face off centre by half the shade vector. Down, the shaded letters are
    centred as a whole, which leaves the faces a touch above centre.

    `plate` is the background color, or None for a transparent glyph. A
    `radius` of 0 gives a full-bleed square for platforms that apply their
    own mask (iOS, maskable PWA icons).
    """
    face = letters(lines, paint)
    shade = extrude(face, *paint.vector)
    minx, miny, maxx, maxy = shade.bounds
    face_minx, _, face_maxx, _ = face.bounds
    cx, cy = (face_minx + face_maxx) / 2, (miny + maxy) / 2
    reach = 2 * max(cx - minx, maxx - cx)
    scale = size * fill / max(reach, maxy - miny)

    def place(geom):
        geom = affinity.translate(geom, -cx, -cy)
        geom = affinity.scale(geom, scale, scale, origin=(0, 0))
        return affinity.translate(geom, size / 2, size / 2)

    body = [f"<title>{title}</title>"]
    if plate:
        body.append(
            f'<rect width="{size:g}" height="{size:g}" rx="{size * radius:.2f}" fill="{plate}"/>'
        )
    body.append(f'<path fill="{paint.shade}" d="{to_path(place(shade))}"/>')
    body.append(f'<path fill="{paint.face}" d="{to_path(place(face))}"/>')
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size:g} {size:g}" '
        f'width="{size:g}" height="{size:g}" role="img">' + "".join(body) + "</svg>\n"
    )
