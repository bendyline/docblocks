/**
 * Entries that never hold user documents. DocBlocks keeps them out of
 * browsing, document discovery, media listing, and change watching; storage
 * operations (read, write, move, remove, snapshot) still reach them.
 */

const TOOL_MANAGED_FOLDER_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  'bower_components',
  '__pycache__',
]);

/** True for dot-entries (`.git`, `.vscode`, `.DS_Store`) and tool-managed folders (`node_modules`). */
export function isIgnoredWorkspaceEntryName(name: string): boolean {
  return name.startsWith('.') || TOOL_MANAGED_FOLDER_NAMES.has(name.toLowerCase());
}
