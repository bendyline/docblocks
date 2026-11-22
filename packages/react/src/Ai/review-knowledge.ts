/**
 * What a review searches knowledge for: the document's subject, as a short
 * search, never the document itself.
 *
 * Left to itself a host searches with the request's last message, which for a
 * review is "Review this Markdown document:" and thousands of words of
 * document, and for a follow-up pass ends in the list of passages already
 * reported. A large catalog matches that by stray words: a general review drew
 * Alaska caselaw into documents that had nothing to do with law. The relevance
 * model scores a query against each passage, and a query shaped like a search
 * does that best, so a review sends the title and headings, which name what
 * the document is about, and the opening text when there are no headings.
 */
import { documentTitle } from './document-title.js';
import { SVG_PICTURE_PLACEHOLDER } from './ai-pictures.js';

/** Characters of query: enough headings to name the subject, short enough to stay a search. */
export const REVIEW_QUERY_CHARACTERS = 600;
/** Characters of opening text, for a document or part without headings of its own. */
const OPENING_CHARACTERS = 300;

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u;
const FENCE = /^ {0,3}(`{3,}|~{3,})/u;
const HEADING = /^ {0,3}#{1,6}(?:[ \t]+(.*))?$/u;
/** Lines that are not prose: tables, HTML, pictures, rules. */
const NOT_PROSE = /^\s*(?:\||<|!\[|(?:[-*_][ \t]*){3,}$)/u;

/** Inline Markdown reduced to its words. */
function plain(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/[*_`~]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** A heading's words, without closing hashes or `{#id .class}` attributes. */
function headingText(text: string): string {
  return plain(text.replace(/[ \t]*\{[^}]*\}[ \t]*$/u, '').replace(/(?:^|[ \t]+)#+[ \t]*$/u, ''));
}

/** `text` cut to `max` characters at a word boundary. */
function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return space > max / 2 ? cut.slice(0, space) : cut;
}

/** The headings of `markdown` outside code fences, and its opening prose. */
function outline(markdown: string): { headings: string[]; opening: string } {
  const headings: string[] = [];
  let opening = '';
  let fence: string | null = null;
  for (const line of markdown.replace(FRONTMATTER, '').split(/\r?\n/u)) {
    if (fence !== null) {
      const marker = FENCE.exec(line)?.[1];
      if (
        marker &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        !line.trim().slice(marker.length).trim()
      ) {
        fence = null;
      }
      continue;
    }
    const opened = FENCE.exec(line)?.[1];
    if (opened) {
      fence = opened;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const text = headingText(heading[1] ?? '');
      if (text) headings.push(text);
      continue;
    }
    if (opening.length >= OPENING_CHARACTERS || !line.trim() || NOT_PROSE.test(line)) continue;
    if (line.includes(SVG_PICTURE_PLACEHOLDER)) continue;
    const prose = plain(line.replace(/^\s*(?:>[ \t]?)*(?:[-*+]|\d+[.)])?[ \t]*/u, ''));
    if (prose) opening = opening ? `${opening} ${prose}` : prose;
  }
  return { headings, opening: cutAtWord(opening, OPENING_CHARACTERS) };
}

/**
 * The knowledge search for reviewing `text`, the whole of `source` or one
 * part of it: the document's title, then the headings in `text`, else the
 * opening of `text`. Empty when `text` holds nothing to search for.
 */
export function reviewKnowledgeQuery(source: string, text: string): string {
  const title = headingText(documentTitle(source));
  const { headings, opening } = outline(text);
  const lines: string[] = [];
  const seen = new Set<string>();
  let characters = 0;
  const add = (line: string) => {
    const key = line.toLowerCase();
    if (!line || seen.has(key) || characters + line.length > REVIEW_QUERY_CHARACTERS) return;
    seen.add(key);
    lines.push(line);
    characters += line.length + 1;
  };
  add(title);
  const own = headings.filter((heading) => heading.toLowerCase() !== title.toLowerCase());
  for (const heading of own) add(heading);
  if (!own.length) add(opening);
  return lines.join('\n');
}
