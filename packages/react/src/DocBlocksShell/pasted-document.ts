/**
 * pasted-document — turns whatever someone pastes into a Markdown document,
 * and names it.
 *
 * Kept out of `DocBlocksShell` so the choices it makes are testable on their
 * own. Three sources reach it: a paste into the paste dialog, text dragged in
 * from another app, and a direct clipboard read from the file pane. Each
 * offers `text/plain`, and often `text/html` beside it.
 *
 * Which of the two to trust is the main decision here:
 *
 *  - An AI chat's Copy button, a Markdown file and most notes apps put
 *    Markdown in `text/plain`. Their HTML, when they offer any, is at best a
 *    rendering of the same thing, and code editors offer syntax-coloured HTML
 *    that would become one long run of styled text.
 *  - A web page, Word or Google Docs put the formatting only in `text/html`;
 *    their `text/plain` has lost every heading, list and table.
 *
 * So clear Markdown in the text wins, then structured HTML, then lists or
 * quotes in the text, and finally the text taken literally.
 */

import { inferDocumentTitle, parseMarkdown, plainTextToMarkdown } from '@bendyline/squisq/markdown';

export interface PastedContent {
  /** The `text/plain` flavour, possibly empty. */
  text: string;
  /** The `text/html` flavour, when the source offered one. */
  html?: string | null;
}

/** Markdown that no plain-text writer produces by accident. */
const STRONG_MARKDOWN_SIGNALS: readonly RegExp[] = [
  /^ {0,3}#{1,6}[ \t]+\S/m, // a heading
  /^ {0,3}(?:```|~~~)/m, // a fenced block
  /^ {0,3}\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/m, // a table's rule row
  /\*\*[^*\n]+\*\*|__[^_\n]+__/, // bold
  /\[[^\]\n]+\]\([^)\s]+\)/, // a link
];

/** Markdown that plain text also contains: lists and quoted lines. */
const WEAK_MARKDOWN_SIGNALS: readonly RegExp[] = [
  /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+\S/m, // a list item
  /^ {0,3}>[ \t]?\S/m, // a quoted line
];

/** HTML that carries structure a document should keep. */
const STRUCTURED_HTML = /<(?:h[1-6]|ul|ol|li|table|blockquote|pre|strong|b|em|i|a)\b/i;

function matchesAny(text: string, signals: readonly RegExp[]): boolean {
  return signals.some((signal) => signal.test(text));
}

function normaliseNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** Lazy, so the editor's first load never pays for the HTML importer. */
async function htmlAsMarkdown(html: string): Promise<string> {
  const { htmlToMarkdown } = await import('@bendyline/squisq-formats/html');
  return htmlToMarkdown(html, {
    // A clipboard's HTML is a fragment: its `<title>` is not the document's.
    headMetadata: false,
    dropHidden: true,
    dropTrackingPixels: true,
    oversize: 'truncate',
  });
}

/**
 * The Markdown a paste should become. Empty when it held no text at all.
 * Rejects only if the HTML importer cannot load or parse.
 */
export async function pastedContentToMarkdown(content: PastedContent): Promise<string> {
  const text = normaliseNewlines(content.text).trim();
  const html = content.html?.trim() ?? '';

  if (text && matchesAny(text, STRONG_MARKDOWN_SIGNALS)) return `${text}\n`;
  if (html && STRUCTURED_HTML.test(html)) {
    const converted = (await htmlAsMarkdown(html)).trim();
    if (converted) return `${converted}\n`;
  }
  if (!text) return '';
  if (matchesAny(text, WEAK_MARKDOWN_SIGNALS)) return `${text}\n`;
  return `${plainTextToMarkdown(text).trim()}\n`;
}

/** A title longer than this is cut back to its last whole word. */
const MAX_TITLE_CHARACTERS = 60;
const MAX_TITLE_WORDS = 8;

/**
 * Openers an AI chat puts before the content it was asked for: "Sure! Here's
 * a draft email to your landlord:" is named "Draft email to your landlord".
 */
const INTERJECTION =
  /^(?:sure|certainly|of course|absolutely|okay|ok|great|no problem)\b[!.,]*\s*/i;
const PRESENTATION = /^(?:here(?:'|’)s|here is|here are|below is|below are)\s+/i;
const LEADING_ARTICLE = /^(?:a|an|the|your)\s+/i;

/** One line of Markdown as the words a reader sees. */
function lineText(line: string): string {
  return line
    .replace(/^ {0,3}(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d{1,9}[.)][ \t]+)/, '')
    .replace(/^\[[ xX]\][ \t]+/, '') // a task list's box
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // pictures
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links keep their words
    .replace(/(\*\*|__|\*|_|~~|`)/g, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1') // escapes plainTextToMarkdown wrote
    .replace(/\s+/g, ' ')
    .trim();
}

function withoutChatPreamble(text: string): string {
  const afterInterjection = text.replace(INTERJECTION, '');
  const afterPresentation = afterInterjection.replace(PRESENTATION, '');
  // "Here's a summary" names a summary; "The committee met" keeps its "The".
  return (
    afterPresentation === afterInterjection
      ? afterPresentation
      : afterPresentation.replace(LEADING_ARTICLE, '')
  ).trim();
}

function firstSentence(text: string): string {
  const end = /[.!?](?=\s|$)/.exec(text);
  return end ? text.slice(0, end.index) : text;
}

/** Cut to whole words, drop closing punctuation, and capitalise. */
function tidyTitle(text: string): string {
  let title = text.replace(/[\s:;,.!?–—-]+$/u, '').trim();
  const words = title.split(' ');
  if (words.length > MAX_TITLE_WORDS) title = words.slice(0, MAX_TITLE_WORDS).join(' ');
  if (title.length > MAX_TITLE_CHARACTERS) {
    const cut = title.slice(0, MAX_TITLE_CHARACTERS + 1);
    const lastSpace = cut.lastIndexOf(' ');
    title = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut.slice(0, MAX_TITLE_CHARACTERS)).trim();
    title = title.replace(/[\s:;,.!?–—-]+$/u, '');
  }
  return title.charAt(0).toLocaleUpperCase() + title.slice(1);
}

/** The front matter block at the top of `markdown`, if any, removed. */
function withoutFrontMatter(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/, '');
}

/**
 * A short name for a pasted document: its front matter title or shallowest
 * heading when it has one, otherwise the first sentence that says something,
 * without a chat assistant's opener. Null when nothing readable is left.
 */
export function titleForPastedMarkdown(markdown: string): string | null {
  const inferred = inferDocumentTitle(parseMarkdown(markdown))?.trim();
  if (inferred) {
    const title = tidyTitle(lineText(inferred));
    if (title) return title;
  }

  let inFence = false;
  for (const raw of withoutFrontMatter(normaliseNewlines(markdown)).split('\n')) {
    if (/^ {0,3}(?:```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^\s*\|/.test(raw)) continue; // table rows
    if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(raw)) continue; // rules
    const text = withoutChatPreamble(lineText(raw));
    if (!text) continue;
    const title = tidyTitle(firstSentence(text));
    if (title) return title;
  }
  return null;
}

/** What a pasted document is called when nothing in it reads as a name. */
export const PASTED_DOCUMENT_FALLBACK_NAME = 'Pasted text';

const RESERVED_WINDOWS_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * A Markdown file name for `title` that every DocBlocks storage accepts:
 * Windows, macOS and Android folders, and browser storage.
 */
export function fileNameForPastedTitle(title: string | null): string {
  let stem = (title ?? '')
    // Separators and characters Windows refuses, plus control characters.
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // No hidden files, and Windows drops trailing dots and spaces.
    .replace(/^\.+/, '')
    .replace(/[.\s]+$/, '');
  if (stem.length > MAX_TITLE_CHARACTERS) stem = stem.slice(0, MAX_TITLE_CHARACTERS).trim();
  if (!stem) stem = PASTED_DOCUMENT_FALLBACK_NAME;
  if (RESERVED_WINDOWS_NAMES.test(stem)) stem = `${stem} document`;
  return `${stem}.md`;
}

export type ClipboardReadResult =
  | { kind: 'content'; content: PastedContent }
  /** The clipboard was readable and held no text. */
  | { kind: 'empty' }
  /** No clipboard API, or the browser or person refused the read. */
  | { kind: 'unavailable' };

type ReadableClipboard = Partial<Pick<Clipboard, 'read' | 'readText'>>;

async function itemText(item: ClipboardItem, type: string): Promise<string> {
  if (!item.types.includes(type)) return '';
  return (await item.getType(type)).text();
}

/**
 * Read text from the system clipboard, HTML included where the platform
 * shares it. Safari and Firefox show their own Paste button for each read,
 * so a refused rich read is not followed by a second, plain one: the person
 * already said no.
 */
export async function readClipboardContent(
  clipboard: ReadableClipboard | null | undefined = globalThis.navigator?.clipboard,
): Promise<ClipboardReadResult> {
  if (!clipboard) return { kind: 'unavailable' };
  if (typeof clipboard.read === 'function') {
    try {
      const items = await clipboard.read();
      let text = '';
      let html = '';
      for (const item of items) {
        text ||= await itemText(item, 'text/plain');
        html ||= await itemText(item, 'text/html');
      }
      return text.trim() || html.trim()
        ? { kind: 'content', content: { text, html: html || null } }
        : { kind: 'empty' };
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        return { kind: 'unavailable' };
      }
      // Anything else (an unsupported flavour, a partial implementation)
      // still leaves the plain read to try.
    }
  }
  if (typeof clipboard.readText !== 'function') return { kind: 'unavailable' };
  try {
    const text = await clipboard.readText();
    return text.trim() ? { kind: 'content', content: { text } } : { kind: 'empty' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/** The text and HTML a paste or drop event carries. */
export function contentFromDataTransfer(data: DataTransfer | null): PastedContent | null {
  if (!data) return null;
  const text = data.getData('text/plain');
  const html = data.getData('text/html');
  if (!text.trim() && !html.trim()) return null;
  return { text, html: html || null };
}
