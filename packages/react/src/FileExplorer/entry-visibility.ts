import type { FileSystemEntry } from '@bendyline/docblocks/filesystem';

/**
 * Hide dot-entries (`.git`, `.gitignore`, `.DS_Store`, …) and generated
 * `<basename>_files/` companion directories from user-facing file lists.
 * These entries remain available to storage, media, and versioning code.
 */
export function isHiddenFileEntry(entry: FileSystemEntry): boolean {
  const name = entry.path.replace(/^\/+/, '').split('/').pop() ?? '';
  if (name.startsWith('.')) return true;
  return entry.kind === 'directory' && name.endsWith('_files');
}

export function filterVisibleFileEntries(entries: readonly FileSystemEntry[]): FileSystemEntry[] {
  return entries.filter((entry) => !isHiddenFileEntry(entry));
}
