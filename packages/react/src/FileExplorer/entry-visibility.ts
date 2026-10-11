import { isBrowsableWorkspaceEntry, type FileSystemEntry } from '@bendyline/docblocks/filesystem';

/**
 * Hide dot-entries (`.git`, `.gitignore`, `.DS_Store`, …), tool-managed
 * folders (`node_modules`, …), and generated `<basename>_files/` companion
 * directories from user-facing file lists. These entries remain available to
 * storage, media, and versioning code.
 */
export function isHiddenFileEntry(entry: FileSystemEntry): boolean {
  const name = entry.path.replace(/^\/+/, '').split('/').pop() ?? '';
  return !isBrowsableWorkspaceEntry(name, entry.kind);
}

export function filterVisibleFileEntries(entries: readonly FileSystemEntry[]): FileSystemEntry[] {
  return entries.filter((entry) => !isHiddenFileEntry(entry));
}
