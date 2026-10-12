/**
 * Recently opened documents, per workspace, most recent first. Quick-open
 * lists them for an empty query and ranks them higher otherwise.
 *
 * Browser-local, like pinned documents: a per-device convenience that is
 * never written into the workspace itself.
 */

import { tryParseWorkspacePath } from '@bendyline/docblocks/filesystem';

export const RECENT_DOCUMENTS_STORAGE_KEY = 'docblocks:recentDocuments:v1';

const MAX_PATHS_PER_WORKSPACE = 50;
const MAX_WORKSPACES = 50;
const MAX_WORKSPACE_ID_LENGTH = 256;
const MAX_PATH_LENGTH = 4096;

export interface RecentDocumentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Workspace id → canonical paths, most recent first. Map order = workspace recency (newest last). */
type RecentDocuments = Map<string, string[]>;

function defaultStorage(): RecentDocumentStorage | null {
  try {
    const candidate = Reflect.get(globalThis, 'localStorage') as unknown;
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      typeof Reflect.get(candidate, 'getItem') !== 'function' ||
      typeof Reflect.get(candidate, 'setItem') !== 'function'
    ) {
      return null;
    }
    return candidate as RecentDocumentStorage;
  } catch {
    return null;
  }
}

function canonicalPath(path: string): string | null {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) return null;
  return tryParseWorkspacePath(path) || null;
}

/** Parse the stored form: `[{ workspaceId, paths }]`, least recently used workspace first. */
export function parseRecentDocuments(value: unknown): RecentDocuments {
  const parsed: RecentDocuments = new Map();
  if (!Array.isArray(value)) return parsed;
  for (const item of value.slice(-MAX_WORKSPACES)) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== 'workspaceId' && key !== 'paths')) continue;
    const { workspaceId, paths } = record;
    if (
      typeof workspaceId !== 'string' ||
      workspaceId.length === 0 ||
      workspaceId.length > MAX_WORKSPACE_ID_LENGTH ||
      !Array.isArray(paths)
    ) {
      continue;
    }
    const canonical: string[] = [];
    for (const path of paths.slice(0, MAX_PATHS_PER_WORKSPACE)) {
      const normalized = typeof path === 'string' ? canonicalPath(path) : null;
      if (normalized && !canonical.includes(normalized)) canonical.push(normalized);
    }
    parsed.delete(workspaceId);
    parsed.set(workspaceId, canonical);
  }
  return parsed;
}

function read(storage: RecentDocumentStorage | null): RecentDocuments {
  if (!storage) return new Map();
  try {
    const raw = storage.getItem(RECENT_DOCUMENTS_STORAGE_KEY);
    return raw ? parseRecentDocuments(JSON.parse(raw)) : new Map();
  } catch {
    return new Map();
  }
}

function write(storage: RecentDocumentStorage | null, documents: RecentDocuments): void {
  if (!storage) return;
  while (documents.size > MAX_WORKSPACES) {
    const oldest = documents.keys().next().value;
    if (oldest === undefined) break;
    documents.delete(oldest);
  }
  const serialized = [...documents].map(([workspaceId, paths]) => ({ workspaceId, paths }));
  try {
    storage.setItem(RECENT_DOCUMENTS_STORAGE_KEY, JSON.stringify(serialized));
  } catch {
    // Quota or privacy mode: recency is a convenience, never an error.
  }
}

/** Recently opened documents in `workspaceId`, most recent first. */
export function loadRecentDocuments(
  workspaceId: string,
  storage: RecentDocumentStorage | null = defaultStorage(),
): readonly string[] {
  return read(storage).get(workspaceId) ?? [];
}

/** Move `path` to the front of `workspaceId`'s recent list. */
export function recordRecentDocument(
  workspaceId: string,
  path: string,
  storage: RecentDocumentStorage | null = defaultStorage(),
): void {
  const canonical = canonicalPath(path);
  if (!canonical || !workspaceId || workspaceId.length > MAX_WORKSPACE_ID_LENGTH) return;
  const documents = read(storage);
  const previous = documents.get(workspaceId) ?? [];
  if (previous[0] === canonical) return;
  const paths = [canonical, ...previous.filter((item) => item !== canonical)].slice(
    0,
    MAX_PATHS_PER_WORKSPACE,
  );
  documents.delete(workspaceId);
  documents.set(workspaceId, paths);
  write(storage, documents);
}

/** Follow a rename or move; a folder move carries every path beneath it. */
export function relocateRecentDocuments(
  workspaceId: string,
  oldPath: string,
  newPath: string,
  storage: RecentDocumentStorage | null = defaultStorage(),
): void {
  const from = canonicalPath(oldPath);
  const to = canonicalPath(newPath);
  if (!from || !to) return;
  const documents = read(storage);
  const paths = documents.get(workspaceId);
  if (!paths) return;
  let changed = false;
  const relocated: string[] = [];
  for (const path of paths) {
    const next =
      path === from ? to : path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path;
    if (next !== path) changed = true;
    if (!relocated.includes(next)) relocated.push(next);
  }
  if (!changed) return;
  documents.set(workspaceId, relocated);
  write(storage, documents);
}

/** Drop a workspace's history, e.g. when the workspace is removed. */
export function forgetRecentDocuments(
  workspaceId: string,
  storage: RecentDocumentStorage | null = defaultStorage(),
): void {
  const documents = read(storage);
  if (!documents.delete(workspaceId)) return;
  write(storage, documents);
}
