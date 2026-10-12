/**
 * The document type last created in each workspace, offered as the default
 * the next time. Someone filling a folder with static Web pages should not
 * have to pick "Web page — Static" every time.
 *
 * This is a personal convenience, so it stays in browser-local storage keyed
 * by workspace id (like pinned documents and the last opened file) rather
 * than in the folder's shared `.docblocks/workspace.json`.
 */

import type { NewFileFormat } from '../FileExplorer/new-file-formats.js';

const STORAGE_KEY = 'docblocks:lastNewFileFormat';
/** Oldest entries are dropped beyond this many workspaces. */
const MAX_REMEMBERED_WORKSPACES = 200;

export const DEFAULT_NEW_FILE_FORMAT: NewFileFormat = 'markdown';

const NEW_FILE_FORMATS: ReadonlySet<string> = new Set<NewFileFormat>([
  'markdown',
  'docx',
  'xlsx',
  'pdf',
  'web-interactive',
  'web-static',
]);

function isNewFileFormat(value: unknown): value is NewFileFormat {
  return typeof value === 'string' && NEW_FILE_FORMATS.has(value);
}

function readAll(): Map<string, NewFileFormat> {
  const remembered = new Map<string, NewFileFormat>();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [workspaceId, format] of Object.entries(parsed)) {
        if (workspaceId && isNewFileFormat(format)) remembered.set(workspaceId, format);
      }
    }
  } catch {
    // Unavailable or corrupt storage: nothing remembered.
  }
  return remembered;
}

/** The type to preselect for a new document in `workspaceId`. */
export function loadLastNewFileFormat(workspaceId: string | null | undefined): NewFileFormat {
  if (!workspaceId) return DEFAULT_NEW_FILE_FORMAT;
  return readAll().get(workspaceId) ?? DEFAULT_NEW_FILE_FORMAT;
}

/** Remember the type just used to create a document in `workspaceId`. */
export function saveLastNewFileFormat(workspaceId: string, format: NewFileFormat): void {
  const remembered = readAll();
  // Re-insert so the map's order tracks recency; trim the least recent.
  remembered.delete(workspaceId);
  remembered.set(workspaceId, format);
  while (remembered.size > MAX_REMEMBERED_WORKSPACES) {
    const oldest = remembered.keys().next().value;
    if (oldest === undefined) break;
    remembered.delete(oldest);
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(remembered)));
  } catch {
    // ignore quota errors
  }
}
