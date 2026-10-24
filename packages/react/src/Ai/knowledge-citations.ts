/**
 * `[n]` citations in AI drafts. The model cites reference passages by number
 * (Gezel's numbered evidence); the numbers mean nothing outside the dialog, so
 * inserted text either names each source in a footnote or drops the markers.
 */

import type { AiChatEvidence } from '@bendyline/docblocks/host';

/**
 * `[3]`, `[1, 4]`, `[2-5]` with any space before it; not a link `[1](…)` or
 * `[text][1]`, a reference definition `[1]:`, an escaped bracket, or an index
 * like `list[1]`.
 */
const MARKER = /[ \t]?(?<![\]\\\p{L}_])\[(\d{1,3}(?:\s*(?:[-–]|,)\s*\d{1,3})*)\](?![(:[])/gu;

function citationNumbers(inner: string): number[] {
  const numbers: number[] = [];
  for (const part of inner.split(',')) {
    const range = /^\s*(\d{1,3})\s*[-–]\s*(\d{1,3})\s*$/u.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      for (let n = Math.min(from, to); n <= Math.max(from, to) && numbers.length < 50; n++) {
        numbers.push(n);
      }
    } else if (/^\s*\d{1,3}\s*$/u.test(part)) numbers.push(Number(part));
  }
  return [...new Set(numbers)];
}

/** Apply `transform` to each line outside fenced code, where `[1]` is code. */
function mapProse(markdown: string, transform: (line: string) => string): string {
  let fence: string | null = null;
  return markdown
    .split('\n')
    .map((line) => {
      const opener = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
      if (fence !== null) {
        if (opener && opener[0] === fence[0] && opener.length >= fence.length) fence = null;
        return line;
      }
      if (opener) {
        fence = opener;
        return line;
      }
      return transform(line);
    })
    .join('\n');
}

/** The draft without citation markers, as text replacing a selection carries it. */
export function stripCitationMarkers(markdown: string): string {
  return mapProse(markdown, (line) => line.replace(MARKER, ''));
}

/**
 * Turn each `[n]` into a footnote naming passage `n`'s article and catalog,
 * so the inserted text keeps its sources (and their attribution) in a form
 * the document understands. Passages from one article share its footnote. A
 * number with no passage is dropped. Labels avoid the footnotes `document`
 * already uses.
 */
export function citationsToFootnotes(
  markdown: string,
  evidence: readonly AiChatEvidence[],
  catalogNames: ReadonlyMap<string, string>,
  document: string,
): string {
  const taken = new Set([...document.matchAll(/\[\^([^\]\s]+)\]/gu)].map((match) => match[1]));
  /** Footnote label → the passage that names it, by article. */
  const labels = new Map<string, { label: string; passage: AiChatEvidence }>();
  let next = 1;
  const labelFor = (n: number): string => {
    const passage = evidence[n - 1];
    const article = passage.title ? `${passage.catalogId}\u0000${passage.title}` : `#${n}`;
    const known = labels.get(article);
    if (known) return known.label;
    let label = `source-${next++}`;
    while (taken.has(label)) label = `source-${next++}`;
    labels.set(article, { label, passage });
    return label;
  };
  const body = mapProse(markdown, (line) =>
    line.replace(MARKER, (_marker, inner: string) =>
      [
        ...new Set(
          citationNumbers(inner)
            .filter((n) => n >= 1 && n <= evidence.length)
            .map(labelFor),
        ),
      ]
        .map((label) => `[^${label}]`)
        .join(''),
    ),
  );
  if (labels.size === 0) return body;
  const notes = [...labels.values()].map(({ label, passage }) => {
    const catalog = catalogNames.get(passage.catalogId) ?? passage.catalogId;
    return `[^${label}]: ${passage.title || 'Untitled article'}, from the ${catalog} knowledge catalog.`;
  });
  return `${body.trimEnd()}\n\n${notes.join('\n')}`;
}
