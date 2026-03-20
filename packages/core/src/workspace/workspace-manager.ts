/**
 * WorkspaceManager — manages the list of known workspaces in IndexedDB
 * and provides helpers for creating / switching / removing them.
 *
 * The actual FileSystemProvider instances are created by the caller
 * (since native providers need a DirectoryHandle from user interaction).
 */

import { LocalForageAdapter } from '@bendyline/squisq/storage';
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
 * Get the list of all known workspace descriptors.
 */
export async function listWorkspaces(): Promise<WorkspaceDescriptor[]> {
  const list = await store.get<WorkspaceDescriptor[]>(LIST_KEY);
  return list ?? [];
}

/**
 * Get a specific workspace descriptor by id.
 */
export async function getWorkspace(id: string): Promise<WorkspaceDescriptor | null> {
  const list = await listWorkspaces();
  return list.find((w) => w.id === id) ?? null;
}

/**
 * Add or update a workspace descriptor. If a workspace with the same id
 * already exists, it is replaced.
 */
export async function saveWorkspace(workspace: WorkspaceDescriptor): Promise<void> {
  const list = await listWorkspaces();
  const idx = list.findIndex((w) => w.id === workspace.id);
  if (idx >= 0) {
    list[idx] = workspace;
  } else {
    list.push(workspace);
  }
  await store.set(LIST_KEY, list);
}

/**
 * Remove a workspace descriptor by id.
 */
export async function removeWorkspace(id: string): Promise<void> {
  const list = await listWorkspaces();
  const filtered = list.filter((w) => w.id !== id);
  await store.set(LIST_KEY, filtered);
}

/**
 * Touch the lastOpened timestamp on a workspace.
 */
export async function touchWorkspace(id: string): Promise<void> {
  const list = await listWorkspaces();
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
