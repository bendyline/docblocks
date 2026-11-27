/**
 * `[n]` citations in AI drafts. The model cites reference passages by number
 * (Gezel's numbered evidence); the numbers mean nothing outside the dialog, so
 * inserted text either names each source in a footnote or drops the markers.
 */

import {
  WORKSPACE_KNOWLEDGE_CATALOG_ID,
  parseWorkspacePassageUri,
  type AiChatEvidence,
} from '@bendyline/docblocks/host';

/** A passage from one of the person's own notes rather than a catalog. */
export function isWorkspaceEvidence(passage: AiChatEvidence): boolean {
  return (
    passage.catalogId === WORKSPACE_KNOWLEDGE_CATALOG_ID ||
    (passage.uri !== undefined && parseWorkspacePassageUri(passage.uri) !== null)
  );
}

/** `to` relative to the folder holding `from`; both are workspace paths. */
function relativeTo(from: string, to: string): string {
  const source = from.replace(/^\/+/u, '').split('/').slice(0, -1);
  const target = to.replace(/^\/+/u, '').split('/');
  let shared = 0;
  while (
    shared < source.length &&
    shared < target.length - 1 &&
    source[shared] === target[shared]
  ) {
    shared += 1;
  }
  return [...source.slice(shared).map(() => '..'), ...target.slice(shared)].join('/');
}

/** A Markdown link to the cited note, or the plain title without one. */
function noteReference(passage: AiChatEvidence, documentPath: string | null): string {
  const title = passage.title || 'Untitled note';
  const reference = passage.uri ? parseWorkspacePassageUri(passage.uri) : null;
  if (!reference || !documentPath) return title;
  const href = relativeTo(documentPath.normalize('NFC'), reference.path)
    .split('/')
    .map((segment) => (segment === '..' ? segment : encodeURIComponent(segment)))
    .join('/');
  return `[${title.replace(/[[\]\\]/gu, '\\$&')}](${href})`;
}

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

/** `text` split at its citation markers: plain runs, and each marker's numbers. */
export function citationParts(text: string): Array<string | number[]> {
  const parts: Array<string | number[]> = [];
  let last = 0;
  for (const match of text.matchAll(MARKER)) {
    const numbers = citationNumbers(match[1] ?? '');
    if (!numbers.length) continue;
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(numbers);
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
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
  /** The open document's workspace path; a cited note is linked relative to it. */
  documentPath: string | null = null,
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
    if (isWorkspaceEvidence(passage)) {
      return `[^${label}]: ${noteReference(passage, documentPath)}, a note in this workspace.`;
    }
    const catalog = catalogNames.get(passage.catalogId) ?? passage.catalogId;
    return `[^${label}]: ${passage.title || 'Untitled article'}, from the ${catalog} knowledge catalog.`;
  });
  return `${body.trimEnd()}\n\n${notes.join('\n')}`;
}
