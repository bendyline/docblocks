/**
 * File names made from what someone typed. A task's name is its file name,
 * so the text has to survive every storage DocBlocks writes to: Windows,
 * macOS and Android folders, and browser storage.
 */

const MAX_STEM_CHARACTERS = 120;

/** Device names Windows will not let a file be called. */
const RESERVED_WINDOWS_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * The stem of a file name for `title`: separators, the characters Windows
 * refuses and control characters become spaces; leading dots (a hidden file)
 * and trailing dots and spaces (which Windows drops) are trimmed. Empty when
 * nothing usable is left.
 */
export function fileStemForTitle(title: string): string {
  let stem = title
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[.\s]+$/, '')
    .trim();
  if (stem.length > MAX_STEM_CHARACTERS) stem = stem.slice(0, MAX_STEM_CHARACTERS).trim();
  if (RESERVED_WINDOWS_NAMES.test(stem)) stem = `${stem} note`;
  return stem;
}

/** A Markdown file name for `title`, or for `fallback` when the title cleans away to nothing. */
export function markdownFileNameForTitle(title: string, fallback: string): string {
  return `${fileStemForTitle(title) || fileStemForTitle(fallback) || 'Untitled'}.md`;
}

/** `Name (2).md` for the second attempt at `Name.md`, and so on. */
export function numberedFileName(fileName: string, attempt: number): string {
  if (attempt <= 1) return fileName;
  const dot = fileName.lastIndexOf('.');
  return dot > 0
    ? `${fileName.slice(0, dot)} (${attempt})${fileName.slice(dot)}`
    : `${fileName} (${attempt})`;
}

/** The stem of a Markdown file name: what a task is called. */
export function titleOfFileName(fileName: string): string {
  const name = fileName.slice(fileName.lastIndexOf('/') + 1);
  return name.replace(/\.(?:md|markdown|mdown)$/i, '');
}
