/**
 * A per-device store of small summaries ("digests"), one per workspace, that
 * let a page show something about workspaces that are not open: what is due
 * in each, say. Values are opaque JSON the caller parses; this module only
 * keeps them, keyed by workspace id.
 *
 * A digest is a cache. It never lives inside a workspace (it would sync, and
 * what it records is specific to this device), and losing it only means the
 * next summary is computed from scratch.
 */

import {
  RawIndexedDBFileSystemStore,
  type IndexedDBFileSystemStore,
} from '../filesystem/indexeddb-store.js';

const DB_NAME = 'docblocks-home';
const STORE_NAME = 'digests';
/** Largest digest kept, as stored JSON text. */
export const WORKSPACE_DIGEST_MAX_CHARACTERS = 2_000_000;

let digestStore: IndexedDBFileSystemStore | null = null;

function store(): IndexedDBFileSystemStore {
  digestStore ??= new RawIndexedDBFileSystemStore(DB_NAME, STORE_NAME);
  return digestStore;
}

/** Replace the storage backend (tests), or restore the default with `null`. */
export function setWorkspaceDigestStore(next: IndexedDBFileSystemStore | null): void {
  digestStore?.close?.();
  digestStore = next;
}

/** Every stored digest, by workspace id, as parsed JSON. Unreadable entries are skipped. */
export async function readWorkspaceDigests(): Promise<ReadonlyMap<string, unknown>> {
  return store().transaction('readonly', async (transaction) => {
    const digests = new Map<string, unknown>();
    for (const key of await transaction.keys()) {
      const text = await transaction.get<unknown>(key);
      if (typeof text !== 'string' || text.length > WORKSPACE_DIGEST_MAX_CHARACTERS) continue;
      try {
        digests.set(key, JSON.parse(text));
      } catch {
        // A damaged entry is a cache miss.
      }
    }
    return digests;
  });
}

/** Keep `digest` for `workspaceId`, replacing what was there. Too large a digest is not kept. */
export async function writeWorkspaceDigest(workspaceId: string, digest: unknown): Promise<boolean> {
  const text = JSON.stringify(digest);
  if (text.length > WORKSPACE_DIGEST_MAX_CHARACTERS) return false;
  await store().transaction('readwrite', (transaction) => transaction.put(workspaceId, text));
  return true;
}

export async function deleteWorkspaceDigest(workspaceId: string): Promise<void> {
  await store().transaction('readwrite', (transaction) => transaction.delete(workspaceId));
}
