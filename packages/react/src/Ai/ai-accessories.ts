/**
 * Side information kept in a document, in AI prompts.
 *
 * Squisq accessory blocks — a heading tagged `{[summary]}`, `{[flashcard]}`,
 * `{[quiz]}` and everything under it — are kept in the document but are not
 * the person's writing: slide wording, AI-written study cards. A reviewer or
 * a writing model shown them would review AI text as the author's, or copy
 * it. Prompts carry the document without them, and a quote found inside one
 * never counts as the place a finding points to.
 */
import { parseMarkdown, withoutAccessorySectionNodes } from '@bendyline/squisq/markdown';

export interface SideInformationRange {
  readonly start: number;
  readonly end: number;
}

/** Cheap pre-check: only a document with a tagged heading can hold side information. */
const TAGGED_HEADING = /^#{1,6}[ \t].*\{\[[A-Za-z]/mu;

/** Where side information sits in `source`: each section from its heading to the next kept block. */
export function sideInformationRanges(source: string): SideInformationRange[] {
  if (!TAGGED_HEADING.test(source)) return [];
  let children;
  try {
    children = parseMarkdown(source).children;
  } catch {
    return [];
  }
  const kept = new Set(withoutAccessorySectionNodes(children));
  const ranges: SideInformationRange[] = [];
  children.forEach((node, index) => {
    if (kept.has(node)) return;
    const start = node.position?.start.offset;
    if (start === undefined) return;
    const next = children.slice(index + 1).find((later) => kept.has(later));
    const end = next?.position?.start.offset ?? source.length;
    const last = ranges[ranges.length - 1];
    if (last && last.end >= start) ranges[ranges.length - 1] = { start: last.start, end };
    else ranges.push({ start, end });
  });
  return ranges;
}

/** `source` without its side information. */
export function withoutSideInformation(source: string): string {
  const ranges = sideInformationRanges(source);
  if (!ranges.length) return source;
  let out = '';
  let at = 0;
  for (const range of ranges) {
    out += source.slice(at, range.start);
    at = range.end;
  }
  return `${out}${source.slice(at)}`.replace(/\n{3,}/gu, '\n\n');
}

/** Whether a range of `source` starts inside side information. */
export function inSideInformation(
  ranges: readonly SideInformationRange[],
  range: { readonly start: number },
): boolean {
  return ranges.some((hidden) => range.start >= hidden.start && range.start < hidden.end);
}
