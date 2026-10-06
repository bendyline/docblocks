/**
 * Turn a diagram spec into markdown, deterministically.
 *
 * The model never writes syntax: ids are generated here, every piece of model
 * text goes through the label sanitizer, and drawing and layout geometry is
 * computed. Mermaid kinds become a ```mermaid fence with an accessible title
 * and description; timelines a Squisq ```timeline fence; steps and cycles a
 * `{[drawing]}`; comparisons and key numbers a `{[layout]}`.
 */

import { renderAsciiTimeline, type AsciiTimeline } from '@bendyline/squisq/doc';
import { bodyLine, cleanLabel, clip, participantLabel, slugId } from './diagram-sanitize.js';
import type {
  ChartSpec,
  ComparisonSpec,
  CycleSpec,
  DiagramKind,
  DiagramSpec,
  FlowSpec,
  HierarchySpec,
  SequenceSpec,
  StatsSpec,
  StepsSpec,
  TimelineSpec,
} from './diagram-spec.js';
import { DIAGRAM_KIND_LABELS } from './diagram-spec.js';

export type DiagramFamily = 'mermaid' | 'timeline' | 'drawing' | 'layout';

export interface CompiledDiagram {
  readonly kind: DiagramKind;
  readonly family: DiagramFamily;
  /**
   * Fences go straight after their passage. Drawings and layouts are heading
   * blocks that own what follows them, so they go at the end of the section.
   */
  readonly placement: 'afterBlock' | 'sectionEnd';
  readonly title: string;
  /** One plain sentence describing the diagram; its text alternative. */
  readonly summary: string;
  /** Source inside the ```mermaid fence, for validation and preview. */
  readonly mermaidSource: string | null;
  /**
   * The markdown to insert. `depth` is the heading depth for a drawing or
   * layout (fences ignore it); generated ids avoid every id in `takenIds`.
   */
  render(depth: number, takenIds: ReadonlySet<string>): string;
}

const SUMMARY_CHARACTERS = 300;
const TITLE_CHARACTERS = 60;

/** Compile `spec`. `title` is the planned diagram title, or empty. */
export function compileDiagram(spec: DiagramSpec, options: { title: string }): CompiledDiagram {
  const title = cleanLabel(options.title, TITLE_CHARACTERS) || DIAGRAM_KIND_LABELS[spec.kind];
  switch (spec.kind) {
    case 'flow':
      return mermaid(spec.kind, title, flowSummary(spec), flowSource(spec, title));
    case 'sequence':
      return mermaid(spec.kind, title, sequenceSummary(spec), sequenceSource(spec, title));
    case 'hierarchy':
      return mermaid(spec.kind, title, hierarchySummary(spec), hierarchySource(spec, title));
    case 'chart':
      return mermaid(spec.kind, title, chartSummary(spec, title), chartSource(spec, title));
    case 'timeline':
      return timeline(spec, title);
    case 'steps':
      return drawing(spec.kind, title, stepsSummary(spec), (depth, ids) =>
        stepsDrawing(spec, title, depth, ids),
      );
    case 'cycle':
      return drawing(spec.kind, title, cycleSummary(spec), (depth, ids) =>
        cycleDrawing(spec, title, depth, ids),
      );
    case 'comparison':
      return layout(spec.kind, title, comparisonSummary(spec), (depth, ids) =>
        comparisonLayout(spec, title, depth, ids),
      );
    case 'stats':
      return layout(spec.kind, title, statsSummary(spec), (depth, ids) =>
        statsLayout(spec, title, depth, ids),
      );
  }
}

// ─── Families ─────────────────────────────────────────────

function fence(lang: string, body: string): string {
  return `\`\`\`${lang}\n${body}\n\`\`\``;
}

function mermaid(
  kind: DiagramKind,
  title: string,
  summary: string,
  source: string,
): CompiledDiagram {
  return {
    kind,
    family: 'mermaid',
    placement: 'afterBlock',
    title,
    summary,
    mermaidSource: source,
    render: () => fence('mermaid', source),
  };
}

function timeline(spec: TimelineSpec, title: string): CompiledDiagram {
  return {
    kind: 'timeline',
    family: 'timeline',
    placement: 'afterBlock',
    title,
    summary: timelineSummary(spec),
    mermaidSource: null,
    render: (_depth, taken) => fence('timeline', timelineArt(spec, title, taken)),
  };
}

function drawing(
  kind: DiagramKind,
  title: string,
  summary: string,
  render: (depth: number, taken: ReadonlySet<string>) => string,
): CompiledDiagram {
  return {
    kind,
    family: 'drawing',
    placement: 'sectionEnd',
    title,
    summary,
    mermaidSource: null,
    render,
  };
}

function layout(
  kind: DiagramKind,
  title: string,
  summary: string,
  render: (depth: number, taken: ReadonlySet<string>) => string,
): CompiledDiagram {
  return {
    kind,
    family: 'layout',
    placement: 'sectionEnd',
    title,
    summary,
    mermaidSource: null,
    render,
  };
}

// ─── Mermaid ──────────────────────────────────────────────

function accessibility(title: string, summary: string): string[] {
  return [
    `  accTitle: ${cleanLabel(title, TITLE_CHARACTERS)}`,
    `  accDescr: ${cleanLabel(summary, SUMMARY_CHARACTERS)}`,
  ];
}

function flowNode(id: string, label: string, shape: FlowSpec['nodes'][number]['shape']): string {
  const text = `"${cleanLabel(label, 48)}"`;
  if (shape === 'decision') return `  ${id}{${text}}`;
  if (shape === 'start' || shape === 'end') return `  ${id}([${text}])`;
  return `  ${id}[${text}]`;
}

function flowSource(spec: FlowSpec, title: string): string {
  const ids = new Map(spec.nodes.map((node, index) => [node.key, `n${String(index + 1)}`]));
  const lines = [`flowchart ${spec.direction}`, ...accessibility(title, flowSummary(spec))];
  for (const node of spec.nodes)
    lines.push(flowNode(ids.get(node.key) ?? 'n0', node.label, node.shape));
  for (const edge of spec.edges) {
    const from = ids.get(edge.from);
    const to = ids.get(edge.to);
    if (!from || !to) continue;
    const label = cleanLabel(edge.label, 24);
    lines.push(label ? `  ${from} -->|"${label}"| ${to}` : `  ${from} --> ${to}`);
  }
  return lines.join('\n');
}

function hierarchySource(spec: HierarchySpec, title: string): string {
  const lines = ['flowchart TD', ...accessibility(title, hierarchySummary(spec))];
  lines.push(`  n1["${cleanLabel(spec.root, 48)}"]`);
  let next = 2;
  for (const child of spec.children) {
    const childId = `n${String(next++)}`;
    lines.push(`  ${childId}["${cleanLabel(child.label, 48)}"]`, `  n1 --> ${childId}`);
    for (const grandchild of child.children) {
      const id = `n${String(next++)}`;
      lines.push(`  ${id}["${cleanLabel(grandchild, 48)}"]`, `  ${childId} --> ${id}`);
    }
  }
  return lines.join('\n');
}

function sequenceSource(spec: SequenceSpec, title: string): string {
  const lines = ['sequenceDiagram', ...accessibility(title, sequenceSummary(spec))];
  spec.participants.forEach((name, index) => {
    lines.push(`  participant p${String(index + 1)} as ${participantLabel(name, 32)}`);
  });
  for (const step of spec.steps) {
    const arrow = step.reply ? '-->>' : '->>';
    lines.push(
      `  p${String(step.from + 1)}${arrow}p${String(step.to + 1)}: ${cleanLabel(step.text, 60)}`,
    );
  }
  return lines.join('\n');
}

/** A number in Mermaid's numeric grammar: no separators, no exponent. */
export function mermaidNumber(value: number): string {
  // toFixed switches to exponent form from 1e21; whole numbers that large
  // print exactly through BigInt instead.
  const fixed =
    Math.abs(value) >= 1e21
      ? BigInt(Math.round(value)).toString()
      : value.toFixed(6).replace(/\.?0+$/u, '');
  return fixed === '-0' ? '0' : fixed;
}

function chartSource(spec: ChartSpec, title: string): string {
  const summary = chartSummary(spec, title);
  const heading = cleanLabel(spec.title || title, TITLE_CHARACTERS);
  if (spec.type === 'pie') {
    const lines = ['pie showData', ...accessibility(title, summary), `  title ${heading}`];
    spec.labels.forEach((label, index) => {
      lines.push(`  "${cleanLabel(label, 32)}" : ${mermaidNumber(spec.values[index] ?? 0)}`);
    });
    return lines.join('\n');
  }
  const labels = spec.labels.map((label) => `"${cleanLabel(label, 32)}"`).join(', ');
  const values = spec.values.map(mermaidNumber).join(', ');
  const lines = [
    'xychart-beta',
    ...accessibility(title, summary),
    `  title "${heading}"`,
    `  x-axis [${labels}]`,
  ];
  if (spec.unit) lines.push(`  y-axis "${cleanLabel(spec.unit, 24)}"`);
  lines.push(`  ${spec.type === 'line' ? 'line' : 'bar'} [${values}]`);
  return lines.join('\n');
}

// ─── Timeline ─────────────────────────────────────────────

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** A fractional year for the date formats prose uses, or null. */
export function timelinePoint(when: string): number | null {
  const text = when.trim().toLowerCase();
  let match = /^(\d{4})$/u.exec(text);
  if (match) return Number(match[1]);
  match = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/u.exec(text);
  if (match)
    return Number(match[1]) + (Number(match[2]) - 1) / 12 + (Number(match[3] ?? 1) - 1) / 365;
  match = /^q([1-4])\s+(\d{4})$/u.exec(text);
  if (match) return Number(match[2]) + (Number(match[1]) - 1) / 4;
  match = /^([a-z]+)\.?\s+(?:(\d{1,2}),?\s+)?(\d{4})$/u.exec(text);
  if (match) {
    const month = MONTHS.indexOf((match[1] ?? '').slice(0, 3));
    if (month < 0) return null;
    return Number(match[3]) + month / 12 + (Number(match[2] ?? 1) - 1) / 365;
  }
  return null;
}

const TIMELINE_SPAN = 60;
const TIMELINE_GAP = 3;

function timelineArt(spec: TimelineSpec, title: string, taken: ReadonlySet<string>): string {
  const points = spec.events.map((event) => timelinePoint(event.when));
  const dated = points.every((point): point is number => point !== null);
  const order = spec.events.map((_, index) => index);
  if (dated) order.sort((a, b) => (points[a] as number) - (points[b] as number));
  const first = dated ? (points[order[0] ?? 0] as number) : 0;
  const last = dated ? (points[order[order.length - 1] ?? 0] as number) : 0;
  const ids = new Set(taken);
  const prefix = slugId('tl', title, ids);
  let previous = -TIMELINE_GAP;
  const events = order.map((index, position) => {
    const event = spec.events[index] ?? { when: '', label: '' };
    const wanted =
      dated && last > first
        ? Math.round((((points[index] as number) - first) / (last - first)) * TIMELINE_SPAN)
        : position * 8;
    // Keep events apart so neighbouring markers never share a column.
    const column = Math.max(wanted, previous + TIMELINE_GAP);
    previous = column;
    return {
      id: `${prefix}-${String(position + 1)}`,
      label: cleanLabel(event.when, 20),
      description: cleanLabel(event.label, 48),
      column,
    };
  });
  const model: AsciiTimeline = {
    tracks: [
      {
        id: prefix,
        label: cleanLabel(title, 32),
        row: 0,
        startColumn: 0,
        endColumn: Math.max(TIMELINE_SPAN, previous),
        events,
      },
    ],
    links: [],
    width: 0,
    height: 0,
    style: 'unicode',
    warnings: [],
  };
  return renderAsciiTimeline(model);
}

// ─── Drawings and layouts ─────────────────────────────────

function heading(depth: number): string {
  return '#'.repeat(Math.min(Math.max(depth, 1), 6));
}

function containerHeading(depth: number, title: string, id: string, template: string): string {
  return `${heading(depth)} ${cleanLabel(title, TITLE_CHARACTERS)} {#${id}} {[${template}]}`;
}

function stepsDrawing(
  spec: StepsSpec,
  title: string,
  depth: number,
  taken: ReadonlySet<string>,
): string {
  const ids = new Set(taken);
  const container = slugId('ai', title, ids);
  const blocks = [containerHeading(depth, title, container, 'drawing')];
  const shapeIds = spec.steps.map((step) => slugId(container, step.label, ids));
  // Up to four steps sit in one row; five or six wrap into rows of three so
  // the boxes stay large once the drawing is fitted to the page.
  const perRow = spec.steps.length > 4 ? 3 : spec.steps.length;
  spec.steps.forEach((step, index) => {
    const x = (index % perRow) * 300;
    const y = Math.floor(index / perRow) * 230;
    blocks.push(
      `${heading(depth + 1)} ${cleanLabel(step.label, 28)} {#${shapeIds[index] ?? ''}} ` +
        `{[rectangle x=${String(x)} y=${String(y)} width=220 height=110 borderRadius=14]}`,
    );
    if (step.detail) blocks.push(bodyLine(step.detail, 60));
  });
  for (let index = 0; index + 1 < shapeIds.length; index++) {
    const wraps = (index + 1) % perRow === 0;
    blocks.push(
      `${heading(depth + 1)} {[arrow from=${shapeIds[index] ?? ''} to=${shapeIds[index + 1] ?? ''}` +
        `${wraps ? ' routing=orthogonal' : ''}]}`,
    );
  }
  return blocks.join('\n\n');
}

function cycleDrawing(
  spec: CycleSpec,
  title: string,
  depth: number,
  taken: ReadonlySet<string>,
): string {
  const ids = new Set(taken);
  const container = slugId('ai', title, ids);
  const count = spec.stages.length;
  const radius = count <= 4 ? 260 : 300;
  const width = 200;
  const height = 90;
  const blocks = [containerHeading(depth, title, container, 'drawing')];
  const shapeIds = spec.stages.map((stage) => slugId(container, stage, ids));
  spec.stages.forEach((stage, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / count;
    // Shift onto non-negative author coordinates; the drawing is fitted anyway.
    const x = Math.round(radius + radius * Math.cos(angle));
    const y = Math.round(radius + radius * Math.sin(angle));
    blocks.push(
      `${heading(depth + 1)} ${cleanLabel(stage, 24)} {#${shapeIds[index] ?? ''}} ` +
        `{[rectangle x=${String(x)} y=${String(y)} width=${String(width)} height=${String(height)} borderRadius=45]}`,
    );
  });
  shapeIds.forEach((id, index) => {
    const next = shapeIds[(index + 1) % count] ?? '';
    blocks.push(`${heading(depth + 1)} {[arrow from=${id} to=${next} routing=curved]}`);
  });
  return blocks.join('\n\n');
}

const CANVAS_WIDTH = 1920;
const MARGIN = 120;
const GUTTER = 80;

function textLayer(depth: number, id: string, params: string, lines: readonly string[]): string {
  return [`${heading(depth)} {#${id}} {[text ${params}]}`, ...lines].join('\n\n');
}

/** Columns of equal width across the 1920-wide layout canvas. */
function columnFrames(count: number): { x: number; width: number }[] {
  const width = Math.floor((CANVAS_WIDTH - 2 * MARGIN - (count - 1) * GUTTER) / count);
  return Array.from({ length: count }, (_, index) => ({
    x: MARGIN + index * (width + GUTTER),
    width,
  }));
}

/** The largest font, from 34 down to 24, at which every column's points fit. */
function pointFontSize(
  columns: readonly ComparisonSpec['columns'][number][],
  width: number,
): number {
  const height = 640;
  for (let size = 34; size > 24; size -= 2) {
    const charsPerLine = Math.max(8, Math.floor(width / (size * 0.55)));
    const lineHeight = size * 1.35;
    const fits = columns.every((column) => {
      const lines = column.points.reduce(
        (sum, point) => sum + Math.ceil((point.length + 2) / charsPerLine) + 0.5,
        0,
      );
      return lines * lineHeight <= height;
    });
    if (fits) return size;
  }
  return 24;
}

function comparisonLayout(
  spec: ComparisonSpec,
  title: string,
  depth: number,
  taken: ReadonlySet<string>,
): string {
  const ids = new Set(taken);
  const container = slugId('ai', title, ids);
  const frames = columnFrames(spec.columns.length);
  const fontSize = pointFontSize(spec.columns, frames[0]?.width ?? 400);
  const blocks = [containerHeading(depth, title, container, 'layout')];
  spec.columns.forEach((column, index) => {
    const frame = frames[index] ?? { x: MARGIN, width: 400 };
    const box = `x=${String(frame.x)} width=${String(frame.width)}`;
    blocks.push(
      textLayer(
        depth + 1,
        slugId(container, `${column.heading}-heading`, ids),
        `${box} y=140 height=110 fontSize=48 fontWeight=bold align=center valign=middle`,
        [bodyLine(column.heading, 32)],
      ),
      textLayer(
        depth + 1,
        slugId(container, `${column.heading}-points`, ids),
        `${box} y=290 height=640 fontSize=${String(fontSize)} align=left valign=top lineHeight=1.35`,
        column.points.map((point) => `• ${cleanLabel(point, 60)}`),
      ),
    );
    if (index > 0) {
      const x = frame.x - GUTTER / 2;
      blocks.push(
        `${heading(depth + 1)} {#${slugId(container, 'divider', ids)}} ` +
          `{[line x=${String(x)} y=160 width=0 height=760 strokeWidth=2]}`,
      );
    }
  });
  return blocks.join('\n\n');
}

function statsLayout(
  spec: StatsSpec,
  title: string,
  depth: number,
  taken: ReadonlySet<string>,
): string {
  const ids = new Set(taken);
  const container = slugId('ai', title, ids);
  const frames = columnFrames(spec.stats.length);
  const longest = Math.max(...spec.stats.map((stat) => stat.value.length));
  const valueSize = Math.min(
    140,
    Math.floor((frames[0]?.width ?? 400) / Math.max(1, longest * 0.6)),
  );
  const blocks = [containerHeading(depth, title, container, 'layout')];
  spec.stats.forEach((stat, index) => {
    const frame = frames[index] ?? { x: MARGIN, width: 400 };
    const box = `x=${String(frame.x)} width=${String(frame.width)}`;
    blocks.push(
      textLayer(
        depth + 1,
        slugId(container, `${stat.label}-value`, ids),
        `${box} y=300 height=220 fontSize=${String(valueSize)} fontWeight=bold align=center valign=bottom`,
        [bodyLine(stat.value, 12)],
      ),
      textLayer(
        depth + 1,
        slugId(container, `${stat.label}-label`, ids),
        `${box} y=540 height=200 fontSize=36 align=center valign=top`,
        [bodyLine(stat.label, 48)],
      ),
    );
  });
  return blocks.join('\n\n');
}

// ─── Summaries ────────────────────────────────────────────

function sentence(value: string): string {
  return clip(value.replace(/\s+/gu, ' ').trim(), SUMMARY_CHARACTERS);
}

function flowSummary(spec: FlowSpec): string {
  return sentence(
    `Flowchart with ${String(spec.nodes.length)} steps: ${spec.nodes.map((n) => n.label).join(', ')}.`,
  );
}

function stepsSummary(spec: StepsSpec): string {
  return sentence(
    `${String(spec.steps.length)} steps in order: ${spec.steps.map((s, i) => `${String(i + 1)}. ${s.label}`).join(', ')}.`,
  );
}

function cycleSummary(spec: CycleSpec): string {
  return sentence(
    `A repeating cycle of ${String(spec.stages.length)} stages: ${spec.stages.join(', ')}, then back to ${spec.stages[0] ?? ''}.`,
  );
}

function sequenceSummary(spec: SequenceSpec): string {
  const name = (index: number) => spec.participants[index] ?? '';
  const steps = spec.steps.map((s) => `${name(s.from)} to ${name(s.to)}: ${s.text}`).join('; ');
  return sentence(`Messages between ${spec.participants.join(', ')}. ${steps}.`);
}

function timelineSummary(spec: TimelineSpec): string {
  return sentence(`Timeline: ${spec.events.map((e) => `${e.when}, ${e.label}`).join('; ')}.`);
}

function hierarchySummary(spec: HierarchySpec): string {
  const parts = spec.children
    .map((c) => (c.children.length ? `${c.label} (${c.children.join(', ')})` : c.label))
    .join('; ');
  return sentence(`${spec.root} breaks down into ${parts}.`);
}

function chartSummary(spec: ChartSpec, title: string): string {
  const unit = spec.unit ? ` ${spec.unit}` : '';
  const points = spec.labels
    .map((label, i) => `${label} ${mermaidNumber(spec.values[i] ?? 0)}${unit}`)
    .join(', ');
  const type =
    spec.type === 'pie' ? 'Pie chart' : spec.type === 'line' ? 'Line chart' : 'Bar chart';
  return sentence(`${type} of ${spec.title || title}: ${points}.`);
}

function comparisonSummary(spec: ComparisonSpec): string {
  return sentence(
    `Comparison of ${spec.columns.map((c) => c.heading).join(' and ')}. ` +
      spec.columns.map((c) => `${c.heading}: ${c.points.join(', ')}`).join('. ') +
      '.',
  );
}

function statsSummary(spec: StatsSpec): string {
  return sentence(`Key numbers: ${spec.stats.map((s) => `${s.value} ${s.label}`).join('; ')}.`);
}
