/**
 * The small JSON specs a model writes instead of diagram syntax.
 *
 * Each kind has one spec. Parsing is tolerant — it accepts common key
 * variants, coerces numbers written as strings, and trims oversized lists
 * (recording a note) — and strict about meaning: a spec that cannot make a
 * useful diagram is rejected with a problem sentence specific enough to put
 * in a repair prompt.
 */

import { extractJson } from './ai-json.js';
import { clip } from './diagram-sanitize.js';

export type DiagramKind =
  | 'flow'
  | 'steps'
  | 'cycle'
  | 'sequence'
  | 'timeline'
  | 'hierarchy'
  | 'chart'
  | 'comparison'
  | 'stats';

export const DIAGRAM_KINDS: readonly DiagramKind[] = [
  'flow',
  'steps',
  'cycle',
  'sequence',
  'timeline',
  'hierarchy',
  'chart',
  'comparison',
  'stats',
];

export const DIAGRAM_KIND_LABELS: Readonly<Record<DiagramKind, string>> = {
  flow: 'Flowchart',
  steps: 'Steps',
  cycle: 'Cycle',
  sequence: 'Sequence',
  timeline: 'Timeline',
  hierarchy: 'Hierarchy',
  chart: 'Chart',
  comparison: 'Comparison',
  stats: 'Key numbers',
};

export type FlowShape = 'step' | 'decision' | 'start' | 'end';

export interface FlowSpec {
  readonly kind: 'flow';
  readonly direction: 'TD' | 'LR';
  readonly nodes: readonly {
    readonly key: string;
    readonly label: string;
    readonly shape: FlowShape;
  }[];
  readonly edges: readonly { readonly from: string; readonly to: string; readonly label: string }[];
}

export interface StepsSpec {
  readonly kind: 'steps';
  readonly steps: readonly { readonly label: string; readonly detail: string }[];
}

export interface CycleSpec {
  readonly kind: 'cycle';
  readonly stages: readonly string[];
}

export interface SequenceSpec {
  readonly kind: 'sequence';
  readonly participants: readonly string[];
  /** `from` and `to` index `participants`. */
  readonly steps: readonly {
    readonly from: number;
    readonly to: number;
    readonly text: string;
    readonly reply: boolean;
  }[];
}

export interface TimelineSpec {
  readonly kind: 'timeline';
  readonly events: readonly { readonly when: string; readonly label: string }[];
}

export interface HierarchySpec {
  readonly kind: 'hierarchy';
  readonly root: string;
  readonly children: readonly { readonly label: string; readonly children: readonly string[] }[];
}

export interface ChartSpec {
  readonly kind: 'chart';
  readonly type: 'bar' | 'line' | 'pie';
  readonly title: string;
  readonly unit: string;
  readonly labels: readonly string[];
  readonly values: readonly number[];
}

export interface ComparisonSpec {
  readonly kind: 'comparison';
  readonly columns: readonly { readonly heading: string; readonly points: readonly string[] }[];
}

export interface StatsSpec {
  readonly kind: 'stats';
  readonly stats: readonly { readonly value: string; readonly label: string }[];
}

export type DiagramSpec =
  | FlowSpec
  | StepsSpec
  | CycleSpec
  | SequenceSpec
  | TimelineSpec
  | HierarchySpec
  | ChartSpec
  | ComparisonSpec
  | StatsSpec;

/** Counts and lengths each kind is held to. Labels beyond a length are clipped. */
export const DIAGRAM_LIMITS = {
  label: 48,
  edgeLabel: 24,
  detail: 60,
  point: 60,
  flowNodes: { min: 2, max: 12 },
  flowEdges: { min: 1, max: 16 },
  steps: { min: 3, max: 6 },
  stages: { min: 3, max: 6 },
  participants: { min: 2, max: 6 },
  messages: { min: 1, max: 12 },
  events: { min: 2, max: 10 },
  hierarchyChildren: { min: 2, max: 6 },
  hierarchyGrandchildren: 5,
  chartPoints: { min: 2, max: 12 },
  piePoints: { min: 2, max: 8 },
  columns: { min: 2, max: 3 },
  columnPoints: { min: 1, max: 5 },
  stats: { min: 2, max: 4 },
  statValue: 12,
} as const;

export type DiagramSpecParse =
  | { readonly ok: true; readonly spec: DiagramSpec; readonly notes: readonly string[] }
  | { readonly ok: false; readonly problem: string };

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The first present field among `keys`. */
function field(record: Rec, ...keys: string[]): unknown {
  for (const key of keys) if (record[key] !== undefined) return record[key];
  return undefined;
}

/** Trimmed text from a string or number, or '' for anything else. */
function text(value: unknown, max: number): string {
  if (typeof value === 'number' && Number.isFinite(value)) return clip(String(value), max);
  if (typeof value !== 'string') return '';
  return clip(value.replace(/\s+/gu, ' ').trim(), max);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A label from a string, or from an object's label/text/name field. */
function labelOf(value: unknown, max: number): string {
  if (isRecord(value)) return text(field(value, 'label', 'text', 'name', 'title'), max);
  return text(value, max);
}

/** Parse a number the way prose writes one: `1,200`, `$3.5`, `45%`, `−2`. */
export function parseLooseNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/[−–]/gu, '-')
    .replace(/[,\s$€£¥%]/gu, '')
    .trim();
  if (!/^[-+]?(\d+(\.\d+)?|\.\d+)$/u.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

class Notes {
  readonly items: string[] = [];
  trim<T>(items: T[], max: number, what: string): T[] {
    if (items.length <= max) return items;
    this.items.push(`Kept the first ${String(max)} ${what} of ${String(items.length)}.`);
    return items.slice(0, max);
  }
}

function tooFew(count: number, min: number, what: string): string {
  return `It needs at least ${String(min)} ${what}, but has ${String(count)}.`;
}

function parseFlow(record: Rec, notes: Notes): DiagramSpec | string {
  const L = DIAGRAM_LIMITS;
  const seen = new Set<string>();
  const nodes: { key: string; label: string; shape: FlowShape }[] = [];
  for (const [index, raw] of list(field(record, 'nodes', 'steps')).entries()) {
    const label = labelOf(raw, L.label);
    if (!label) continue;
    const id = isRecord(raw) ? text(field(raw, 'id', 'key'), 40) : '';
    const key = id || `node${String(index + 1)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const shapeRaw = isRecord(raw) ? text(field(raw, 'shape', 'type'), 20).toLowerCase() : '';
    const shape: FlowShape =
      shapeRaw === 'decision' || shapeRaw === 'question'
        ? 'decision'
        : shapeRaw === 'start'
          ? 'start'
          : shapeRaw === 'end' || shapeRaw === 'stop'
            ? 'end'
            : 'step';
    nodes.push({ key, label, shape });
  }
  const keptNodes = notes.trim(nodes, L.flowNodes.max, 'boxes');
  if (keptNodes.length < L.flowNodes.min) return tooFew(keptNodes.length, L.flowNodes.min, 'nodes');
  // Edges may name nodes by id or by their label.
  const resolve = (value: unknown): string | null => {
    const name = text(value, 60);
    if (!name) return null;
    const byKey = keptNodes.find((node) => node.key === name);
    if (byKey) return byKey.key;
    const byLabel = keptNodes.find((node) => node.label.toLowerCase() === name.toLowerCase());
    return byLabel?.key ?? null;
  };
  const edges: { from: string; to: string; label: string }[] = [];
  let dangling = 0;
  const pairs = new Set<string>();
  for (const raw of list(field(record, 'edges', 'links', 'connections'))) {
    if (!isRecord(raw)) continue;
    const from = resolve(field(raw, 'from', 'source'));
    const to = resolve(field(raw, 'to', 'target'));
    if (!from || !to || from === to) {
      dangling++;
      continue;
    }
    const pair = `${from}→${to}`;
    if (pairs.has(pair)) continue;
    pairs.add(pair);
    edges.push({ from, to, label: text(field(raw, 'label', 'text'), L.edgeLabel) });
  }
  if (dangling > 0) notes.items.push(`Dropped ${String(dangling)} link(s) to unknown boxes.`);
  const keptEdges = notes.trim(edges, L.flowEdges.max, 'links');
  if (keptEdges.length < L.flowEdges.min) {
    return 'It needs at least 1 edge whose "from" and "to" are node ids from "nodes".';
  }
  const direction = text(field(record, 'direction'), 4).toUpperCase() === 'LR' ? 'LR' : 'TD';
  return { kind: 'flow', direction, nodes: keptNodes, edges: keptEdges };
}

function parseSteps(record: Rec, notes: Notes): DiagramSpec | string {
  const L = DIAGRAM_LIMITS;
  const steps = list(field(record, 'steps', 'items'))
    .map((raw) => ({
      label: labelOf(raw, 28),
      detail: isRecord(raw) ? text(field(raw, 'detail', 'description'), L.detail) : '',
    }))
    .filter((step) => step.label);
  const kept = notes.trim(steps, L.steps.max, 'steps');
  if (kept.length < L.steps.min) return tooFew(kept.length, L.steps.min, 'steps');
  return { kind: 'steps', steps: kept };
}

function parseCycle(record: Rec, notes: Notes): DiagramSpec | string {
  const L = DIAGRAM_LIMITS;
  const stages = list(field(record, 'stages', 'steps', 'items'))
    .map((raw) => labelOf(raw, 24))
    .filter(Boolean);
  const kept = notes.trim(stages, L.stages.max, 'stages');
  if (kept.length < L.stages.min) return tooFew(kept.length, L.stages.min, 'stages');
  return { kind: 'cycle', stages: kept };
}

function parseSequence(record: Rec, notes: Notes): DiagramSpec | string {
  const L = DIAGRAM_LIMITS;
  const participants: string[] = [];
  const indexOf = (name: string): number => {
    const lower = name.toLowerCase();
    return participants.findIndex((participant) => participant.toLowerCase() === lower);
  };
  for (const raw of list(field(record, 'participants', 'actors'))) {
    const name = labelOf(raw, 32);
    if (name && indexOf(name) < 0) participants.push(name);
  }
  const steps: { from: number; to: number; text: string; reply: boolean }[] = [];
  for (const raw of list(field(record, 'steps', 'messages'))) {
    if (!isRecord(raw)) continue;
    const fromName = text(field(raw, 'from', 'source'), 32);
    const toName = text(field(raw, 'to', 'target'), 32);
    const message = text(field(raw, 'text', 'message', 'label'), DIAGRAM_LIMITS.detail);
    if (!fromName || !toName || !message) continue;
    // A participant only named in a message still belongs in the diagram.
    for (const name of [fromName, toName]) {
      if (indexOf(name) < 0 && participants.length < L.participants.max) participants.push(name);
    }
    const from = indexOf(fromName);
    const to = indexOf(toName);
    if (from < 0 || to < 0) continue;
    steps.push({ from, to, text: message, reply: field(raw, 'reply', 'response') === true });
  }
  if (participants.length > L.participants.max) {
    return `It names ${String(participants.length)} participants; use at most ${String(L.participants.max)}.`;
  }
  if (participants.length < L.participants.min) {
    return tooFew(participants.length, L.participants.min, 'participants');
  }
  const kept = notes.trim(steps, L.messages.max, 'messages');
  if (kept.length < L.messages.min) {
    return 'It needs at least 1 step whose "from" and "to" are participants.';
  }
  return { kind: 'sequence', participants, steps: kept };
}

function parseTimeline(record: Rec, notes: Notes): DiagramSpec | string {
  const L = DIAGRAM_LIMITS;
  const events = list(field(record, 'events', 'items'))
    .filter(isRecord)
    .map((raw) => ({
      when: text(field(raw, 'when', 'date', 'time', 'year'), 20),
      label: text(field(raw, 'label', 'event', 'text', 'title'), L.label),
    }))
    .filter((event) => event.when && event.label);
  const kept = notes.trim(events, L.events.max, 'events');
  if (kept.length < L.events.min) {
    return tooFew(kept.length, L.events.min, 'events with both "when" and "label"');
  }
  return { kind: 'timeline', events: kept };
}

function parseHierarchy(record: Rec, notes: Notes): DiagramSpec | string {
  const L = DIAGRAM_LIMITS;
  const root = labelOf(field(record, 'root', 'title', 'label'), L.label);
  if (!root) return 'It needs a "root" label.';
  const children = list(field(record, 'children', 'parts'))
    .map((raw) => ({
      label: labelOf(raw, L.label),
      children: isRecord(raw)
        ? list(field(raw, 'children', 'parts'))
            .map((child) => labelOf(child, L.label))
            .filter(Boolean)
            .slice(0, L.hierarchyGrandchildren)
        : [],
    }))
    .filter((child) => child.label);
  const kept = notes.trim(children, L.hierarchyChildren.max, 'branches');
  if (kept.length < L.hierarchyChildren.min) {
    return tooFew(kept.length, L.hierarchyChildren.min, 'children');
  }
  return { kind: 'hierarchy', root, children: kept };
}

function parseChart(record: Rec, notes: Notes): DiagramSpec | string {
  const L = DIAGRAM_LIMITS;
  const typeRaw = text(field(record, 'type', 'chart'), 12).toLowerCase();
  const type = typeRaw.includes('pie') ? 'pie' : typeRaw.includes('line') ? 'line' : 'bar';
  const labels = list(field(record, 'labels', 'categories'))
    .map((raw) => labelOf(raw, 32))
    .filter(Boolean);
  const valuesRaw = list(field(record, 'values', 'data'));
  const values = valuesRaw.map(parseLooseNumber);
  if (values.some((value) => value === null)) {
    return '"values" must be numbers copied from the passage.';
  }
  const count = Math.min(labels.length, values.length);
  if (labels.length !== values.length) {
    notes.items.push(`Matched ${String(count)} labels to values.`);
  }
  const max = type === 'pie' ? L.piePoints.max : L.chartPoints.max;
  const min = type === 'pie' ? L.piePoints.min : L.chartPoints.min;
  const keptLabels = notes.trim(labels.slice(0, count), max, 'points');
  const keptValues = (values as number[]).slice(0, keptLabels.length);
  if (keptLabels.length < min) return tooFew(keptLabels.length, min, 'labelled values');
  if (type === 'pie' && keptValues.some((value) => value <= 0)) {
    return 'A pie chart needs positive values.';
  }
  return {
    kind: 'chart',
    type,
    title: text(field(record, 'title'), 60),
    unit: text(field(record, 'unit', 'units'), 24),
    labels: keptLabels,
    values: keptValues,
  };
}

function parseComparison(record: Rec, notes: Notes): DiagramSpec | string {
  const L = DIAGRAM_LIMITS;
  const columns = list(field(record, 'columns', 'options'))
    .filter(isRecord)
    .map((raw) => ({
      heading: text(field(raw, 'heading', 'title', 'name', 'label'), 32),
      points: labelList(list(field(raw, 'points', 'items', 'bullets')), L.point).slice(
        0,
        L.columnPoints.max,
      ),
    }))
    .filter((column) => column.heading && column.points.length >= L.columnPoints.min);
  const kept = notes.trim(columns, L.columns.max, 'columns');
  if (kept.length < L.columns.min) {
    return tooFew(kept.length, L.columns.min, 'columns with a heading and points');
  }
  return { kind: 'comparison', columns: kept };
}

function labelList(values: unknown[], max: number): string[] {
  return values.map((value) => labelOf(value, max)).filter(Boolean);
}

function parseStats(record: Rec, notes: Notes): DiagramSpec | string {
  const L = DIAGRAM_LIMITS;
  const stats = list(field(record, 'stats', 'numbers', 'items'))
    .filter(isRecord)
    .map((raw) => ({
      value: text(field(raw, 'value', 'number', 'stat'), L.statValue),
      label: text(field(raw, 'label', 'description', 'text'), L.label),
    }))
    .filter((stat) => stat.value && stat.label);
  const kept = notes.trim(stats, L.stats.max, 'numbers');
  if (kept.length < L.stats.min) return tooFew(kept.length, L.stats.min, 'numbers with labels');
  return { kind: 'stats', stats: kept };
}

const PARSERS: Readonly<Record<DiagramKind, (record: Rec, notes: Notes) => DiagramSpec | string>> =
  {
    flow: parseFlow,
    steps: parseSteps,
    cycle: parseCycle,
    sequence: parseSequence,
    timeline: parseTimeline,
    hierarchy: parseHierarchy,
    chart: parseChart,
    comparison: parseComparison,
    stats: parseStats,
  };

/** Parse a model reply as the spec for `kind`. */
export function parseDiagramSpec(kind: DiagramKind, reply: string): DiagramSpecParse {
  const extracted = extractJson(reply, 'object');
  if (!extracted.ok) return { ok: false, problem: extracted.problem };
  const notes = new Notes();
  const result = PARSERS[kind](extracted.value as Rec, notes);
  if (typeof result === 'string') return { ok: false, problem: result };
  return { ok: true, spec: result, notes: notes.items };
}

/** True when `value` names a diagram kind. */
export function isDiagramKind(value: unknown): value is DiagramKind {
  return typeof value === 'string' && (DIAGRAM_KINDS as readonly string[]).includes(value);
}
