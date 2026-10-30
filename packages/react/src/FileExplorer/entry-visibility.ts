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

function comparablePath(path: string): string {
  return path.replace(/^\/+/, '').toLowerCase();
}

/**
 * Also leaves out files at `hiddenPaths` (workspace-relative, matched
 * case-insensitively): host-generated files such as the workspace catalog.
 */
export function filterVisibleFileEntries(
  entries: readonly FileSystemEntry[],
  hiddenPaths: readonly string[] = [],
): FileSystemEntry[] {
  const hidden = new Set(hiddenPaths.map(comparablePath));
  return entries.filter(
    (entry) =>
      !isHiddenFileEntry(entry) &&
      !(entry.kind === 'file' && hidden.has(comparablePath(entry.path))),
  );
}
