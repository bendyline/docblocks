/**
 * The types a new document can be created as. Shared by the explorer's inline
 * new-file form and the shell's New document dialog so both name the result
 * the same way; `NewFileFormatOptions` renders the matching choices.
 */

import type { OutsideInHtmlOutput } from '../DocBlocksShell/outside-in-contract.js';

export type NewFileFormat = 'markdown' | 'docx' | 'xlsx' | 'pdf' | 'web-interactive' | 'web-static';

const NEW_FILE_EXTENSIONS: Record<NewFileFormat, string> = {
  markdown: '.md',
  docx: '.docx',
  xlsx: '.xlsx',
  pdf: '.pdf',
  'web-interactive': '.html',
  'web-static': '.html',
};

const SELECTABLE_FILE_EXTENSION = /\.(?:md|docx|xlsx|pdf|html?)$/i;

/**
 * The file name for `name` created as `format`. A typed extension the picker
 * offers is replaced, so the chosen type always wins. `null` when nothing is
 * left before the extension.
 */
export function newFileName(name: string, format: NewFileFormat): string | null {
  const stem = name.trim().replace(SELECTABLE_FILE_EXTENSION, '');
  return stem ? `${stem}${NEW_FILE_EXTENSIONS[format]}` : null;
}

/** The HTML output style a Web page format asks for; undefined for the rest. */
export function newFileHtmlOutput(format: NewFileFormat): OutsideInHtmlOutput | undefined {
  if (format === 'web-static') return 'static';
  if (format === 'web-interactive') return 'interactive';
  return undefined;
}
