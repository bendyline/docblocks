/**
 * The rules of a journal folder: one Markdown file per day, named for the
 * day and kept in a folder per year (`Journal/2026/2026-11-23.md`).
 *
 * An entry's date is its file name. Nothing is stored beside it, so an entry
 * written in another editor, or one that has not been read yet, is dated as
 * surely as one made here.
 */

import {
  parseWorkspacePath,
  workspacePathBasename,
  workspacePathContains,
  workspacePathJoin,
  type WorkspacePath,
} from '../filesystem/workspace-path.js';
import { isLocalDate, type LocalDate } from '../properties/dates.js';

/** A day, optionally followed by a few words: `2026-11-23.md`, `2026-11-23 Lisbon.md`. */
const ENTRY_NAME = /^(\d{4}-\d{2}-\d{2})(?:[ _-].*)?\.(?:md|markdown|mdown)$/i;

/** The day a journal entry is for, read from its file name; null when the name is not a day. */
export function journalDateFromPath(path: string): LocalDate | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const match = ENTRY_NAME.exec(name);
  return match && isLocalDate(match[1]) ? match[1]! : null;
}

/** Where the entry for `date` lives in `folder`. */
export function journalEntryPath(folder: WorkspacePath, date: LocalDate): WorkspacePath {
  if (!isLocalDate(date)) throw new RangeError('Not a calendar date.');
  return workspacePathJoin(folder, `${date.slice(0, 4)}/${date}.md`);
}

/**
 * The entry for `date` among `paths`, wherever in the journal it was put:
 * the one at the usual place when it exists, else the first by path.
 */
export function findJournalEntry(
  folder: WorkspacePath,
  paths: Iterable<string>,
  date: LocalDate,
): WorkspacePath | null {
  const usual = journalEntryPath(folder, date);
  let found: WorkspacePath | null = null;
  for (const candidate of paths) {
    if (candidate === usual) return usual;
    const path = parseWorkspacePath(candidate);
    if (!workspacePathContains(folder, path, false)) continue;
    if (journalDateFromPath(workspacePathBasename(path)) !== date) continue;
    if (found === null || path < found) found = path;
  }
  return found;
}

/** `Monday, 23 November 2026`, in the reader's language. */
export function journalEntryHeading(date: LocalDate, locale?: string | readonly string[]): string {
  if (!isLocalDate(date)) throw new RangeError('Not a calendar date.');
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  // Formatted in UTC from a UTC instant, so the reader's time zone cannot move the day.
  const instant = new Date(Date.UTC(year, month - 1, day));
  instant.setUTCFullYear(year);
  return new Intl.DateTimeFormat(locale as string | string[] | undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(instant);
}

/** The Markdown a new entry starts with. */
export function journalEntryMarkdown(date: LocalDate, locale?: string | readonly string[]): string {
  return `# ${journalEntryHeading(date, locale)}\n\n`;
}
