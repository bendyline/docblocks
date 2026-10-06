/**
 * Check a diagram's facts against the passage it illustrates.
 *
 * Small models invent numbers and dates as readily as they copy them. Every
 * chart value and headline number must appear in the passage, every timeline
 * date must match one there, and most labels must share a word with it.
 * Links between boxes cannot be checked this way; the UI says so instead.
 */

import type { DiagramSpec } from './diagram-spec.js';
import { parseLooseNumber } from './diagram-spec.js';

export interface GroundingResult {
  readonly ok: boolean;
  /** Specific enough to hand back to the model in a repair prompt. */
  readonly problems: readonly string[];
}

const LABEL_SHARE_REQUIRED = 0.6;

const STOPWORDS = new Set(
  (
    'a an and are as at be by for from has have in into is it its of on or that the then this to ' +
    'was were will with without your you we our they their them there these those than which who ' +
    'what when where how why not no yes can may also each per via'
  ).split(' '),
);

const SCALE: Readonly<Record<string, number>> = {
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  mn: 1e6,
  million: 1e6,
  b: 1e9,
  bn: 1e9,
  billion: 1e9,
  t: 1e12,
  trillion: 1e12,
};

/**
 * Every number written in `text`, in each form a model might copy it as:
 * `$3.5M` yields 3.5 and 3,500,000; `45%` yields 45 and 0.45.
 */
export function extractNumbers(text: string): number[] {
  const found: number[] = [];
  const pattern = /[-−]?\d[\d,]*(?:\.\d+)?|[-−]?\.\d+/gu;
  for (const match of text.matchAll(pattern)) {
    const value = parseLooseNumber(match[0]);
    if (value === null) continue;
    found.push(value);
    const after = text.slice(
      (match.index ?? 0) + match[0].length,
      (match.index ?? 0) + match[0].length + 10,
    );
    const suffix = /^\s?(%|thousand|million|billion|trillion|bn|mn|[kmbt])(?![\p{L}\p{N}])/iu.exec(
      after,
    );
    const unit = suffix?.[1]?.toLowerCase();
    if (unit === '%') found.push(value / 100);
    else if (unit && SCALE[unit]) found.push(value * (SCALE[unit] ?? 1));
  }
  return found;
}

function sameNumber(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/** Lower-case word stems: `planning` and `plans` both become `plan`. */
export function contentTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const word of text
    .toLowerCase()
    .normalize('NFKD')
    .match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    tokens.add(stem(word));
  }
  return tokens;
}

function stem(word: string): string {
  for (const suffix of ['ing', 'ed', 'es', 's', 'ly']) {
    if (word.length > suffix.length + 3 && word.endsWith(suffix)) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

/** The labels a spec puts on screen, other than numbers. */
function labelsOf(spec: DiagramSpec): string[] {
  switch (spec.kind) {
    case 'flow':
      return spec.nodes.map((node) => node.label);
    case 'steps':
      return spec.steps.map((step) => step.label);
    case 'cycle':
      return [...spec.stages];
    case 'sequence':
      return [...spec.participants, ...spec.steps.map((step) => step.text)];
    case 'hierarchy':
      return [spec.root, ...spec.children.flatMap((child) => [child.label, ...child.children])];
    case 'comparison':
      return spec.columns.flatMap((column) => [column.heading, ...column.points]);
    case 'timeline':
      return spec.events.map((event) => event.label);
    case 'chart':
      return [...spec.labels];
    case 'stats':
      return spec.stats.map((stat) => stat.label);
  }
}

function checkLabels(labels: readonly string[], passage: Set<string>): string | null {
  const meaningful = labels.filter((label) => contentTokens(label).size > 0);
  if (meaningful.length === 0) return null;
  const unsupported = meaningful.filter(
    (label) => ![...contentTokens(label)].some((token) => passage.has(token)),
  );
  if (meaningful.length - unsupported.length >= LABEL_SHARE_REQUIRED * meaningful.length)
    return null;
  const sample = unsupported
    .slice(0, 4)
    .map((label) => `"${label}"`)
    .join(', ');
  return `These labels are not supported by the passage: ${sample}. Use words from the passage.`;
}

function yearsIn(text: string): string[] {
  return text.match(/\b(1\d{3}|2\d{3})\b/gu) ?? [];
}

/** Whether `spec` sticks to facts stated in `passage`. */
export function checkGrounding(spec: DiagramSpec, passage: string): GroundingResult {
  const problems: string[] = [];
  const passageNumbers = extractNumbers(passage);
  const has = (value: number) => passageNumbers.some((known) => sameNumber(known, value));

  if (spec.kind === 'chart') {
    const missing = spec.values.filter((value) => !has(value));
    if (missing.length > 0) {
      problems.push(
        `These numbers are not in the passage: ${missing.slice(0, 6).join(', ')}. Copy values exactly.`,
      );
    }
  }
  if (spec.kind === 'stats') {
    const lowerPassage = passage.toLowerCase();
    const missing = spec.stats.filter((stat) => {
      const numbers = extractNumbers(stat.value);
      return numbers.length > 0
        ? !numbers.some(has)
        : !lowerPassage.includes(stat.value.toLowerCase());
    });
    if (missing.length > 0) {
      problems.push(
        `These numbers are not in the passage: ${missing.map((stat) => stat.value).join(', ')}.`,
      );
    }
  }
  if (spec.kind === 'timeline') {
    const passageYears = new Set(yearsIn(passage));
    const lowerPassage = passage.toLowerCase();
    const missing = spec.events.filter((event) => {
      const years = yearsIn(event.when);
      return years.length > 0
        ? !years.every((year) => passageYears.has(year))
        : !lowerPassage.includes(event.when.toLowerCase());
    });
    if (missing.length > 0) {
      problems.push(
        `These dates are not in the passage: ${missing.map((event) => event.when).join(', ')}.`,
      );
    }
  }
  const labels = checkLabels(labelsOf(spec), contentTokens(passage));
  if (labels) problems.push(labels);
  return { ok: problems.length === 0, problems };
}
