/**
 * File names as the explorer shows and renames them.
 *
 * Markdown documents read as plain titles: the file tree and the pinned list
 * both hide `.md`. Renaming used to seed its field with the raw `Name.md`,
 * wholly selected, so typing a new title silently dropped the extension and
 * left an extension-less file — one the editor's own Markdown handling and
 * every other app on the machine no longer recognised.
 */

/** The extension the lists hide. */
const HIDDEN_EXTENSION = '.md';

/**
 * A trailing `.ext` that reads as a real extension rather than part of a
 * title: "Q3 report.docx" and "archive.7z" have one, "Pricing v1.2" and
 * "Notes – draft 2." do not. Requiring a letter is what keeps a version
 * number from passing for an extension.
 */
const EXTENSION = /\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,10}$/;

function hidesExtension(name: string): boolean {
  return name.endsWith(HIDDEN_EXTENSION) && name.length > HIDDEN_EXTENSION.length;
}

/** Where `name`'s extension starts, or -1. A dotfile's dot is not one. */
function extensionStart(name: string): number {
  const match = EXTENSION.exec(name);
  return match && match.index > 0 ? match.index : -1;
}

/** The name a list row shows: Markdown documents without their `.md`. */
export function displayFileName(name: string): string {
  return hidesExtension(name) ? name.slice(0, -HIDDEN_EXTENSION.length) : name;
}

export interface RenameDraft {
  /** What the rename field starts with. */
  readonly value: string;
  /** Pre-select `value` up to here, so typing replaces the title but never the extension. */
  readonly selectionEnd: number;
}

/**
 * The rename field's starting state. A Markdown document shows its title
 * alone, as the lists do. Any other file shows its full name with only the
 * part before the extension selected — the Finder and VS Code behavior.
 */
export function renameDraft(name: string, kind: 'file' | 'directory'): RenameDraft {
  if (kind === 'file' && hidesExtension(name)) {
    const value = displayFileName(name);
    return { value, selectionEnd: value.length };
  }
  const start = kind === 'file' ? extensionStart(name) : -1;
  return { value: name, selectionEnd: start >= 0 ? start : name.length };
}

/**
 * The name a rename produces from what was typed, or `null` when it is empty
 * or changes nothing.
 *
 * A Markdown document stays one: its field never showed `.md`, so `.md` goes
 * back on (once — typing it anyway does not double it). Another file keeps
 * its extension if the new name has none, while typing a different extension
 * is taken as deliberate.
 */
export function renamedFileName(
  name: string,
  typed: string,
  kind: 'file' | 'directory',
): string | null {
  let next = typed.trim();
  if (!next) return null;
  if (kind === 'file') {
    if (hidesExtension(name)) {
      if (!next.toLowerCase().endsWith(HIDDEN_EXTENSION)) next += HIDDEN_EXTENSION;
    } else {
      const start = extensionStart(name);
      if (start >= 0 && extensionStart(next) < 0) next += name.slice(start);
    }
  }
  return next === name ? null : next;
}

/**
 * The toolbar title field's name for a document: its name without the
 * extension, whatever its type. The field renames a document; it never
 * changes its type. That stays with the file list's rename, which shows the
 * full name.
 */
export function titleFieldName(name: string): string {
  const start = hidesExtension(name) ? name.length - HIDDEN_EXTENSION.length : extensionStart(name);
  return start >= 0 ? name.slice(0, start) : name;
}

/**
 * The name a title-field edit produces: what was typed, with the document's
 * own extension put back. Typing that extension anyway does not double it;
 * any other ending is part of the name, never a new type. `null` when the
 * edit is empty or changes nothing.
 */
export function renamedFromTitle(name: string, typed: string): string | null {
  const next = typed.trim();
  if (!next) return null;
  const extension = name.slice(titleFieldName(name).length);
  const renamed =
    extension && !next.toLowerCase().endsWith(extension.toLowerCase()) ? next + extension : next;
  return renamed === name ? null : renamed;
}
