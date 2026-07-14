/**
 * WorkspaceManager — manages the list of known workspaces in IndexedDB
 * and provides helpers for creating / switching / removing them.
 *
 * The actual FileSystemProvider instances are created by the caller
 * (since native providers need a DirectoryHandle from user interaction).
 */

import { LocalForageAdapter } from '@bendyline/squisq/storage';
import { getFileSystemProviderV2, type FileSystemProvider } from '../filesystem/types.js';
import type { WorkspaceDescriptor } from './types.js';

const DB_NAME = 'docblocks-workspaces';
const STORE_NAME = 'workspaces';
const LIST_KEY = 'workspace-list';
const DEFAULT_WORKSPACE_ID = 'default';

const store = new LocalForageAdapter({
  name: DB_NAME,
  storeName: STORE_NAME,
});

/**
 * Session-only transient workspaces (a loose file/`.dbk` opened from the OS,
 * or a document copied from a shared URL). Kept purely in memory — never
 * written to the persisted list — with their pre-built provider registered
 * alongside the descriptor. Lost on reload, which is the intended
 * "transient for the app session" behaviour.
 */
interface TransientEntry {
  descriptor: WorkspaceDescriptor;
  provider: FileSystemProvider;
}
const transientWorkspaces = new Map<string, TransientEntry>();

/** Register a transient workspace and its (already-built) provider. */
export function registerTransientWorkspace(
  descriptor: WorkspaceDescriptor,
  provider: FileSystemProvider,
): void {
  const previous = transientWorkspaces.get(descriptor.id);
  if (previous && previous.provider !== provider) {
    void getFileSystemProviderV2(previous.provider)?.dispose();
  }
  transientWorkspaces.set(descriptor.id, { descriptor, provider });
}

/** Look up a transient workspace (descriptor + provider) by id, if any. */
export function getTransientWorkspace(
  id: string,
): { descriptor: WorkspaceDescriptor; provider: FileSystemProvider } | null {
  return transientWorkspaces.get(id) ?? null;
}

/** Forget a transient workspace (e.g. when it is closed). */
export async function unregisterTransientWorkspace(id: string): Promise<void> {
  const entry = transientWorkspaces.get(id);
  if (!entry) return;
  transientWorkspaces.delete(id);
  await getFileSystemProviderV2(entry.provider)?.dispose();
}

/** The persisted (on-disk) workspace list only — excludes transient ones. */
async function listPersisted(): Promise<WorkspaceDescriptor[]> {
  const list = await store.get<WorkspaceDescriptor[]>(LIST_KEY);
  return list ?? [];
}

/**
 * Get all known workspace descriptors — persisted plus any session-only
 * transient ones (so they show in the picker and resolve for the session).
 */
export async function listWorkspaces(): Promise<WorkspaceDescriptor[]> {
  const persisted = await listPersisted();
  const transient = [...transientWorkspaces.values()].map((t) => t.descriptor);
  return [...persisted, ...transient];
}

/**
 * Get a specific workspace descriptor by id (transient or persisted).
 */
export async function getWorkspace(id: string): Promise<WorkspaceDescriptor | null> {
  const transient = transientWorkspaces.get(id);
  if (transient) return transient.descriptor;
  const list = await listPersisted();
  return list.find((w) => w.id === id) ?? null;
}

/**
 * Add or update a workspace descriptor. If a workspace with the same id
 * already exists, it is replaced. Transient workspaces are never persisted.
 */
export async function saveWorkspace(workspace: WorkspaceDescriptor): Promise<void> {
  if (workspace.type === 'transient') return;
  const list = await listPersisted();
  const idx = list.findIndex((w) => w.id === workspace.id);
  if (idx >= 0) {
    list[idx] = workspace;
  } else {
    list.push(workspace);
  }
  await store.set(LIST_KEY, list);
}

/**
 * Remove a workspace descriptor by id (transient or persisted).
 */
export async function removeWorkspace(id: string): Promise<void> {
  if (transientWorkspaces.has(id)) {
    await unregisterTransientWorkspace(id);
    return;
  }
  const list = await listPersisted();
  const filtered = list.filter((w) => w.id !== id);
  await store.set(LIST_KEY, filtered);
}

/**
 * Touch the lastOpened timestamp on a workspace. For transient workspaces this
 * updates the in-memory descriptor only (nothing is persisted).
 */
export async function touchWorkspace(id: string): Promise<void> {
  const transient = transientWorkspaces.get(id);
  if (transient) {
    transient.descriptor.lastOpened = new Date().toISOString();
    return;
  }
  const list = await listPersisted();
  const workspace = list.find((w) => w.id === id);
  if (workspace) {
    workspace.lastOpened = new Date().toISOString();
    await store.set(LIST_KEY, list);
  }
}

/**
 * Ensure a default IndexedDB workspace exists. Called on app startup.
 * Returns the descriptor.
 */
export async function ensureDefaultWorkspace(): Promise<WorkspaceDescriptor> {
  const existing = await getWorkspace(DEFAULT_WORKSPACE_ID);
  if (existing) return existing;

  const descriptor: WorkspaceDescriptor = {
    id: DEFAULT_WORKSPACE_ID,
    name: 'My Documents',
    type: 'indexeddb',
    lastOpened: new Date().toISOString(),
  };
  await saveWorkspace(descriptor);
  return descriptor;
}
