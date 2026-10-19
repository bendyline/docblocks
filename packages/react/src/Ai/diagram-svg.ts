/**
 * Draw the diagram kinds Mermaid and Squisq drawings have no shape for —
 * Venn diagrams, 2×2 matrices, funnels and pyramids — as SVG pictures.
 *
 * Geometry is computed and every label passes through the label sanitizer and
 * XML escaping, so model text can never become markup. The output is plain
 * SVG that Squisq's island sanitizer keeps whole: no scripts, links, fonts or
 * fixed colors. Everything is drawn in `currentColor` — solid for text and
 * outlines, translucent for fills — so a picture follows the theme's text
 * color in the editor, on dark slides, and in Word and EPUB exports.
 */

import { cleanLabel, clip } from './diagram-sanitize.js';
import type { FunnelSpec, MatrixSpec, PyramidSpec, VennSpec } from './diagram-spec.js';

/** Average glyph width of a sans-serif face, in ems; deliberately generous. */
const CHAR_WIDTH = 0.58;
const LINE_HEIGHT = 1.25;
const MIN_FONT = 10;

function xml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

/** One line of text with control characters removed, clipped to `max`. */
function plainText(value: string, max: number): string {
  return clip(
    value
      .normalize('NFC')
      .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim(),
    max,
  );
}

function num(value: number): string {
  return String(Math.round(value * 10) / 10);
}

interface TextBlock {
  readonly size: number;
  readonly lines: readonly string[];
}

/** Greedy word wrap; a word longer than a line is clipped on a line of its own. */
function wrapWords(text: string, perLine: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/u).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= perLine) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    line = word.length > perLine ? clip(word, perLine) : word;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The largest size from `size` down at which `text` wraps, whole words only,
 * into `maxLines` lines of `width`; past the smallest size, the end is clipped.
 */
function fitText(text: string, width: number, maxLines: number, size: number): TextBlock {
  const perLineAt = (fontSize: number) => Math.max(4, Math.floor(width / (fontSize * CHAR_WIDTH)));
  const longestWord = Math.max(0, ...text.split(/\s+/u).map((word) => word.length));
  for (let fontSize = size; fontSize >= MIN_FONT; fontSize -= 1) {
    const perLine = perLineAt(fontSize);
    if (longestWord > perLine) continue;
    const lines = wrapWords(text, perLine);
    if (lines.length <= maxLines) return { size: fontSize, lines };
  }
  const perLine = perLineAt(MIN_FONT);
  const lines = wrapWords(text, perLine);
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = clip(lines.slice(maxLines - 1).join(' '), perLine);
  return { size: MIN_FONT, lines: kept };
}

function blockHeight(block: TextBlock): number {
  return block.lines.length * block.size * LINE_HEIGHT;
}

/** A centered text block whose first line's top sits at `top`. */
function textAt(x: number, top: number, block: TextBlock, bold = false): string {
  const lineHeight = block.size * LINE_HEIGHT;
  const tspans = block.lines.map((line, index) => {
    // Alphabetic baseline sits about 0.35em below a line's middle.
    const baseline = top + (index + 0.5) * lineHeight + block.size * 0.35;
    return `<tspan x="${num(x)}" y="${num(baseline)}">${xml(line)}</tspan>`;
  });
  return (
    `  <text text-anchor="middle" font-size="${String(block.size)}"` +
    `${bold ? ' font-weight="700"' : ''}>${tspans.join('')}</text>`
  );
}

/**
 * Texts stacked and centered on (`x`, `middle`) within `width` × `height`,
 * shrinking every one together until the stack fits.
 */
function stack(
  texts: readonly string[],
  x: number,
  middle: number,
  width: number,
  height: number,
  size: number,
  maxLinesEach = 2,
): string[] {
  if (texts.length === 0) return [];
  const gap = 0.45;
  for (let fontSize = size; ; fontSize -= 1) {
    const blocks = texts.map((text) => fitText(text, width, maxLinesEach, fontSize));
    const total =
      blocks.reduce((sum, block) => sum + blockHeight(block), 0) +
      gap * fontSize * (blocks.length - 1);
    if (total <= height || fontSize <= MIN_FONT) {
      let top = middle - total / 2;
      return blocks.map((block) => {
        const element = textAt(x, top, block);
        top += blockHeight(block) + gap * fontSize;
        return element;
      });
    }
  }
}

function svgDocument(
  width: number,
  height: number,
  title: string,
  summary: string,
  body: readonly string[],
): string {
  // XML escaping keeps these safe; they need no look-alike characters.
  const name = plainText(title, 60);
  const description = plainText(summary, 300);
  return [
    `<svg viewBox="0 0 ${String(width)} ${String(height)}" width="${String(width)}" ` +
      `height="${String(height)}" role="img" aria-label="${xml(`${name}. ${description}`)}" ` +
      'font-family="sans-serif" fill="currentColor">',
    `  <title>${xml(name)}</title>`,
    `  <desc>${xml(description)}</desc>`,
    ...body,
    '</svg>',
  ].join('\n');
}

const SHAPE = 'fill="currentColor" stroke="currentColor" stroke-width="2"';

function label(value: string, max: number): string {
  return cleanLabel(value, max);
}

// ─── Venn ─────────────────────────────────────────────────

const VENN_RADIUS = 150;

interface VennLayout {
  readonly width: number;
  readonly height: number;
  readonly centers: readonly (readonly [number, number])[];
  /** Where each set's own items go, and how wide that space is. */
  readonly regions: readonly { readonly x: number; readonly y: number; readonly width: number }[];
  readonly labels: readonly { readonly x: number; readonly y: number }[];
  readonly shared: { readonly x: number; readonly y: number; readonly width: number };
}

function vennLayout(count: number): VennLayout {
  if (count === 2) {
    return {
      width: 640,
      height: 400,
      centers: [
        [245, 220],
        [395, 220],
      ],
      regions: [
        { x: 168, y: 220, width: 130 },
        { x: 472, y: 220, width: 130 },
      ],
      labels: [
        { x: 168, y: 34 },
        { x: 472, y: 34 },
      ],
      shared: { x: 320, y: 220, width: 112 },
    };
  }
  return {
    width: 640,
    height: 560,
    centers: [
      [320, 200],
      [245, 330],
      [395, 330],
    ],
    regions: [
      { x: 320, y: 112, width: 150 },
      { x: 186, y: 392, width: 120 },
      { x: 454, y: 392, width: 120 },
    ],
    labels: [
      { x: 320, y: 16 },
      { x: 175, y: 500 },
      { x: 465, y: 500 },
    ],
    shared: { x: 320, y: 286, width: 84 },
  };
}

export function vennSvg(spec: VennSpec, title: string, summary: string): string {
  const layout = vennLayout(spec.sets.length);
  const body: string[] = [];
  for (const [cx, cy] of layout.centers) {
    body.push(
      `  <circle cx="${String(cx)}" cy="${String(cy)}" r="${String(VENN_RADIUS)}" ${SHAPE} ` +
        'fill-opacity="0.1" stroke-opacity="0.6"/>',
    );
  }
  spec.sets.forEach((set, index) => {
    const at = layout.labels[index] ?? { x: 0, y: 0 };
    body.push(textAt(at.x, at.y, fitText(label(set.label, 24), 220, 1, 18), true));
    const region = layout.regions[index] ?? { x: 0, y: 0, width: 100 };
    const height = spec.sets.length === 2 ? 220 : 110;
    body.push(
      ...stack(
        set.items.map((item) => label(item, 28)),
        region.x,
        region.y,
        region.width,
        height,
        14,
      ),
    );
  });
  const shared = layout.shared;
  body.push(
    ...stack(
      spec.shared.map((item) => label(item, 28)),
      shared.x,
      shared.y,
      shared.width,
      spec.sets.length === 2 ? 220 : 90,
      14,
    ),
  );
  return svgDocument(layout.width, layout.height, title, summary, body);
}

// ─── 2×2 matrix ───────────────────────────────────────────

export function matrixSvg(spec: MatrixSpec, title: string, summary: string): string {
  const axes = Boolean(spec.xAxis || spec.yAxis);
  const left = axes ? 64 : 16;
  const top = 16;
  const cellWidth = 280;
  const cellHeight = 210;
  const gap = 8;
  const gridRight = left + 2 * cellWidth + gap;
  const gridBottom = top + 2 * cellHeight + gap;
  const width = gridRight + 16;
  const height = gridBottom + (axes ? 64 : 16);
  const body: string[] = [];
  spec.quadrants.forEach((quadrant, index) => {
    const x = left + (index % 2) * (cellWidth + gap);
    const y = top + Math.floor(index / 2) * (cellHeight + gap);
    // The top right corner is the one most frameworks single out; tint it most.
    const tint = index === 1 ? 0.16 : index === 2 ? 0.05 : 0.1;
    body.push(
      `  <rect x="${String(x)}" y="${String(y)}" width="${String(cellWidth)}" ` +
        `height="${String(cellHeight)}" rx="12" fill="currentColor" fill-opacity="${String(tint)}"/>`,
    );
    const heading = fitText(label(quadrant.label, 28), cellWidth - 32, 2, 18);
    body.push(textAt(x + cellWidth / 2, y + 18, heading, true));
    const itemsTop = y + 18 + blockHeight(heading) + 10;
    body.push(
      ...stack(
        quadrant.items.map((item) => label(item, 40)),
        x + cellWidth / 2,
        (itemsTop + y + cellHeight - 14) / 2,
        cellWidth - 40,
        y + cellHeight - 14 - itemsTop,
        14,
      ),
    );
  });
  if (axes) {
    body.push(
      '  <defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" ' +
        'markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" ' +
        'fill="currentColor"/></marker></defs>',
    );
    if (spec.xAxis) {
      const y = gridBottom + 18;
      body.push(
        `  <line x1="${String(left)}" y1="${String(y)}" x2="${String(gridRight)}" y2="${String(y)}" ` +
          'stroke="currentColor" stroke-width="2" marker-end="url(#arrow)"/>',
        textAt((left + gridRight) / 2, y + 12, fitText(label(spec.xAxis, 24), 300, 1, 15)),
      );
    }
    if (spec.yAxis) {
      const x = left - 18;
      const middle = (top + gridBottom) / 2;
      const block = fitText(label(spec.yAxis, 24), 300, 1, 15);
      body.push(
        `  <line x1="${String(x)}" y1="${String(gridBottom)}" x2="${String(x)}" y2="${String(top)}" ` +
          'stroke="currentColor" stroke-width="2" marker-end="url(#arrow)"/>',
        `  <g transform="rotate(-90 ${num(x - 20)} ${num(middle)})">`,
        `  ${textAt(x - 20, middle - blockHeight(block) / 2, block)}`,
        '  </g>',
      );
    }
  }
  return svgDocument(width, height, title, summary, body);
}

// ─── Funnels and pyramids ─────────────────────────────────

interface Band {
  readonly topWidth: number;
  readonly bottomWidth: number;
  readonly y: number;
  readonly height: number;
}

/** Stacked trapezoids centered on `center`, widths interpolated from `from` to `to`. */
function bands(count: number, from: number, to: number, height: number, gap: number): Band[] {
  const total = count * height + (count - 1) * gap;
  const widthAt = (y: number) => from + ((to - from) * y) / total;
  return Array.from({ length: count }, (_, index) => {
    const y = index * (height + gap);
    return { topWidth: widthAt(y), bottomWidth: widthAt(y + height), y, height };
  });
}

function trapezoid(band: Band, center: number, top: number, opacity: number): string {
  const y1 = top + band.y;
  const y2 = y1 + band.height;
  const points = [
    [center - band.topWidth / 2, y1],
    [center + band.topWidth / 2, y1],
    [center + band.bottomWidth / 2, y2],
    [center - band.bottomWidth / 2, y2],
  ]
    .map(([x, y]) => `${num(x ?? 0)},${num(y ?? 0)}`)
    .join(' ');
  return (
    `  <polygon points="${points}" fill="currentColor" fill-opacity="${num(opacity)}" ` +
    'stroke="currentColor" stroke-opacity="0.5" stroke-width="1.5" stroke-linejoin="round"/>'
  );
}

export function funnelSvg(spec: FunnelSpec, title: string, summary: string): string {
  const width = 640;
  const center = width / 2;
  const top = 12;
  const bandHeight = 66;
  const gap = 6;
  const layout = bands(spec.stages.length, 600, 220, bandHeight, gap);
  const body: string[] = [];
  spec.stages.forEach((stage, index) => {
    const band = layout[index];
    if (!band) return;
    body.push(trapezoid(band, center, top, 0.08 + (0.16 * index) / spec.stages.length));
    const room = Math.min(band.topWidth, band.bottomWidth) - 36;
    const name = fitText(label(stage.label, 28), room, 1, 16);
    const middle = top + band.y + band.height / 2;
    if (stage.value) {
      const value = fitText(label(stage.value, 12), room, 1, 20);
      const total = blockHeight(value) + blockHeight(name);
      body.push(
        textAt(center, middle - total / 2, value, true),
        textAt(center, middle - total / 2 + blockHeight(value), name),
      );
    } else {
      body.push(textAt(center, middle - blockHeight(name) / 2, name, true));
    }
  });
  const height = top * 2 + spec.stages.length * (bandHeight + gap) - gap;
  return svgDocument(width, height, title, summary, body);
}

export function pyramidSvg(spec: PyramidSpec, title: string, summary: string): string {
  const width = 640;
  const center = width / 2;
  const top = 12;
  const count = spec.levels.length;
  const bandHeight = count <= 4 ? 76 : 62;
  const gap = 6;
  const layout = bands(count, 200, 620, bandHeight, gap);
  const body: string[] = [];
  spec.levels.forEach((level, index) => {
    const band = layout[index];
    if (!band) return;
    // Darkest at the top, the level the pyramid builds toward.
    body.push(trapezoid(band, center, top, 0.24 - (0.16 * index) / count));
    // Text sits mid-band, where the band is a little wider than its top edge.
    const room = band.topWidth + (band.bottomWidth - band.topWidth) * 0.25 - 36;
    const block = fitText(label(level, 32), room, 2, 17);
    const middle = top + band.y + band.height / 2;
    body.push(textAt(center, middle - blockHeight(block) / 2, block, index === 0));
  });
  const height = top * 2 + count * (bandHeight + gap) - gap;
  return svgDocument(width, height, title, summary, body);
}
