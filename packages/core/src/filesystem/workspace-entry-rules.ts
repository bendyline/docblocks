/**
 * Which workspace entries DocBlocks browses, discovers, and watches.
 *
 * The explorer, link picker, catalog generator, and watcher each used to keep
 * a private copy of these rules, and the copies drifted (`.md` in one place,
 * `.md`/`.markdown` in another, `_files` matched case-insensitively in only
 * one walker). Storage operations (read, write, move, remove, snapshot) still
 * reach every entry; these rules only decide what is shown and indexed.
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

/**
 * The folder holding DocBlocks' own metadata: `workspace.json` at a workspace
 * root, `folder.json` inside any folder that says what it is for.
 */
export const WORKSPACE_METADATA_DIRECTORY_NAME = '.docblocks';

/**
 * Names a recursive listing (`enumerate`) reports. Ignored names are left
 * out, with one exception: the metadata folder is listed (and never entered),
 * so a reader can tell which folders may carry settings without probing each.
 */
export function isEnumeratedWorkspaceEntryName(name: string): boolean {
  return name === WORKSPACE_METADATA_DIRECTORY_NAME || !isIgnoredWorkspaceEntryName(name);
}

/** Extensions DocBlocks opens as Markdown documents, lower-case. */
export const MARKDOWN_FILE_EXTENSIONS: readonly string[] = Object.freeze([
  '.md',
  '.markdown',
  '.mdown',
]);

/** True for `notes.md`, `Notes.MARKDOWN`, or a path ending in one. */
export function isMarkdownFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return MARKDOWN_FILE_EXTENSIONS.some(
    (extension) => lower.length > extension.length && lower.endsWith(extension),
  );
}

/**
 * The media folder paired with a document (`notes.md` → `notes_files/`).
 * Case-sensitive, matching what DocBlocks writes.
 */
export function isCompanionDirectoryName(name: string): boolean {
  return name.endsWith('_files');
}

/** Folder where outside-in exports keep the shared Squisq player runtime. */
export const SQUISQ_RUNTIME_DIRECTORY_NAME = '_squisq';

/** Entries the file explorer shows. */
export function isBrowsableWorkspaceEntry(name: string, kind: 'file' | 'directory'): boolean {
  if (isIgnoredWorkspaceEntryName(name)) return false;
  return kind === 'file' || !isCompanionDirectoryName(name);
}

/** Entries that document discovery (link picker, catalog, workspace index) lists or descends into. */
export function isDiscoverableWorkspaceEntry(name: string, kind: 'file' | 'directory'): boolean {
  if (!isBrowsableWorkspaceEntry(name, kind)) return false;
  return kind === 'file' || name !== SQUISQ_RUNTIME_DIRECTORY_NAME;
}

/**
 * A file manager's copy of a companion folder: `notes_files - Copy`
 * (Windows), `notes_files copy 2` (macOS), `notes_files (1)`, or a sync
 * client's `notes_files (Sam's conflicted copy)`. It holds a document's media
 * like the original, so it is no place to put one.
 */
const COMPANION_COPY = /_files(?: - [Cc]opy(?: \(\d+\))?| [Cc]opy(?: \d+)?| \d+| \([^)]*\))$/;

/**
 * DocBlocks' own support folders: page templates (`_templates/post.html`, the
 * convention workspace settings point at) and the player runtime. Only these
 * two: other underscore folders (a static site's `_posts` or `_drafts`) are
 * real places for documents.
 */
const SUPPORT_FOLDER_NAMES: ReadonlySet<string> = new Set([
  '_templates',
  SQUISQ_RUNTIME_DIRECTORY_NAME,
]);

/**
 * Folders offered as somewhere to put a document (the workspace folder
 * picker): not hidden or tool-managed ones, not companions or a copy of one,
 * and not DocBlocks' support folders (`_templates`, `_squisq`). A folder
 * inside one of these is not offered either; callers check each segment of a
 * path.
 */
export function isDestinationFolderName(name: string): boolean {
  if (isIgnoredWorkspaceEntryName(name) || isCompanionDirectoryName(name)) return false;
  return !COMPANION_COPY.test(name) && !SUPPORT_FOLDER_NAMES.has(name.toLowerCase());
}
