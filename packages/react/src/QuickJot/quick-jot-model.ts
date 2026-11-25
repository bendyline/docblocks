/**
 * Quick Jot's draft and the choices made about it, kept apart from the panel
 * so they can be tested without rendering it.
 */

import { isImageAttachment } from '../Home/attachments.js';

export interface JotAttachment {
  readonly id: string;
  readonly file: File;
  readonly kind: 'image' | 'file';
}

/** What is in the box: typed, pasted or dictated text, and dropped or pasted files. */
export interface JotDraft {
  readonly text: string;
  readonly attachments: readonly JotAttachment[];
}

/**
 * What became of a jot: all of it was used, none of it was (keep everything),
 * or the text was used but the files could not be kept with it.
 */
export type JotOutcome = 'used' | 'kept' | 'text-used';

/** Enough for a day's photos; more is an import, not a jot. */
export const MAX_JOT_ATTACHMENTS = 20;
/** Per file. Attachments are read into memory to be written. */
export const MAX_JOT_ATTACHMENT_BYTES = 200 * 1024 * 1024;

/** Drags from DocBlocks' own file tree and task board, which carry no new content. */
const INTERNAL_DRAG_TYPES = ['application/x-docblocks-entry', 'application/x-docblocks-task'];

let nextId = 0;

export function jotAttachment(file: File): JotAttachment {
  nextId += 1;
  return { id: `jot-${nextId}`, file, kind: isImageAttachment(file) ? 'image' : 'file' };
}

/** True when a drag brings files from outside DocBlocks. */
export function dragCarriesFiles(data: DataTransfer | null): boolean {
  if (!data) return false;
  const types = Array.from(data.types);
  return types.includes('Files') && !types.some((type) => INTERNAL_DRAG_TYPES.includes(type));
}

/**
 * Add `files` to the attachments, within the limits. `refused` says, in plain
 * words, what was left out and why.
 */
export function withAttachments(
  current: readonly JotAttachment[],
  files: readonly File[],
): { attachments: JotAttachment[]; refused: string | null } {
  const attachments = [...current];
  let tooLarge = 0;
  let tooMany = 0;
  for (const file of files) {
    if (file.size > MAX_JOT_ATTACHMENT_BYTES) tooLarge += 1;
    else if (attachments.length >= MAX_JOT_ATTACHMENTS) tooMany += 1;
    else attachments.push(jotAttachment(file));
  }
  const refused =
    tooLarge > 0
      ? `${tooLarge === 1 ? 'That file is' : `${tooLarge} files are`} too large for Quick Jot. Import ${tooLarge === 1 ? 'it' : 'them'} from the file list instead.`
      : tooMany > 0
        ? `Quick Jot keeps up to ${MAX_JOT_ATTACHMENTS} files. Import the rest from the file list.`
        : null;
  return { attachments, refused };
}

/** A task's title (the first line) and notes (everything after it). */
export function splitJotTask(text: string): { title: string; notes: string } {
  const lines = text.trim().split('\n');
  const first = lines.findIndex((line) => line.trim() !== '');
  if (first < 0) return { title: '', notes: '' };
  return {
    title: lines[first]!.trim(),
    notes: lines
      .slice(first + 1)
      .join('\n')
      .trim(),
  };
}

/** `text` with `inserted` in place of the characters from `start` to `end`. */
export function spliceText(
  text: string,
  start: number,
  end: number,
  inserted: string,
): { text: string; caret: number } {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  return {
    text: `${text.slice(0, from)}${inserted}${text.slice(to)}`,
    caret: from + inserted.length,
  };
}

/** A dictated phrase added to the end of the text, a space apart. */
export function withDictatedPhrase(text: string, phrase: string): string {
  const words = phrase.trim();
  if (!words) return text;
  if (!text.trim()) return words;
  return /\s$/.test(text) ? `${text}${words}` : `${text} ${words}`;
}
