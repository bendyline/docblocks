/**
 * Browser-local persistence for dismissed ("Ignore") proofing findings.
 *
 * Squisq deliberately never writes dismissals into the document — they are
 * one person's editing preference, and a file travelling through git must not
 * carry them to everyone else. So the engine's state is handed to the host,
 * scoped per document, and DocBlocks keeps it beside its other browser-local
 * preferences.
 *
 * The stored payload is the engine's OPAQUE export: it holds context hashes as
 * integers above 2^53, so it is only ever moved as a string and handed back
 * verbatim. Nothing here parses it.
 *
 * Entries are keyed by workspace **and** path, matching `last-state` and
 * `pinned-documents`: the same relative path means different documents in
 * different workspaces, and dismissals must not leak between them.
 */

import type { ProofingDocumentRef, ProofingIgnoreStore } from '@bendyline/squisq-editor-react';

const STORAGE_KEY = 'docblocks:proofingIgnores';

/**
 * Bounds. `localStorage` is a shared ~5 MiB budget for the whole app, and this
 * is the one preference that grows without a user ever managing a list — every
 * dismissal in every document lands here. Oversized payloads are dropped and
 * the least recently written documents are evicted, so proofing can never be
 * the reason saving a workspace preference starts failing.
 */
const MAX_ENTRY_CHARACTERS = 64 * 1024;
const MAX_DOCUMENTS = 200;

interface IgnoreEntry {
  /** The engine's opaque export. Never parsed. */
  readonly json: string;
  /** Epoch millis of the last write, used only for eviction order. */
  readonly savedAt: number;
}

export interface ProofingIgnoreStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Resolve `localStorage` without assuming it exists or is reachable. Private
 * modes and embedded contexts can throw on mere property access.
 */
function resolveStorage(): ProofingIgnoreStorage | null {
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
    return candidate as ProofingIgnoreStorage;
  } catch {
    return null;
  }
}

/** Composite key for one document. `\u0000` cannot occur in either half. */
export function proofingIgnoreKey(workspaceId: string, documentPath: string): string {
  return `${workspaceId}\u0000${documentPath}`;
}

function readAll(storage: ProofingIgnoreStorage): Record<string, IgnoreEntry> {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const entries: Record<string, IgnoreEntry> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const json = Reflect.get(value, 'json');
      const savedAt = Reflect.get(value, 'savedAt');
      if (typeof json !== 'string' || json.length > MAX_ENTRY_CHARACTERS) continue;
      entries[key] = { json, savedAt: typeof savedAt === 'number' ? savedAt : 0 };
    }
    return entries;
  } catch {
    // Malformed or unreadable — dismissals are a convenience, not data worth
    // failing the editor over.
    return {};
  }
}

function writeAll(storage: ProofingIgnoreStorage, entries: Record<string, IgnoreEntry>): void {
  const keys = Object.keys(entries);
  if (keys.length > MAX_DOCUMENTS) {
    // Evict least recently written first.
    const ordered = keys.sort((a, b) => (entries[a]?.savedAt ?? 0) - (entries[b]?.savedAt ?? 0));
    for (const key of ordered.slice(0, keys.length - MAX_DOCUMENTS)) delete entries[key];
  }
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Quota exceeded or storage denied — the ignores still apply this session.
  }
}

/**
 * Create the store DocBlocks hands to Squisq.
 *
 * `resolveWorkspaceId` is read at call time rather than captured, because the
 * active workspace changes underneath a mounted shell. A store created while
 * no workspace is active simply does not persist: an unsaved scratch buffer
 * keeping its dismissals only for the session is the documented behavior.
 */
export function createLocalProofingIgnoreStore(
  resolveWorkspaceId: () => string | null,
  storageOverride?: ProofingIgnoreStorage | null,
): ProofingIgnoreStore {
  const storage = storageOverride ?? resolveStorage();

  const keyFor = (document: ProofingDocumentRef): string | null => {
    const workspaceId = resolveWorkspaceId();
    if (!workspaceId) return null;
    const documentPath = document.fileName ?? document.articleId;
    if (!documentPath) return null;
    return proofingIgnoreKey(workspaceId, documentPath);
  };

  return {
    load(document: ProofingDocumentRef): string | undefined {
      if (!storage) return undefined;
      const key = keyFor(document);
      if (!key) return undefined;
      return readAll(storage)[key]?.json;
    },
    save(document: ProofingDocumentRef, ignoredJson: string): void {
      if (!storage) return;
      const key = keyFor(document);
      if (!key) return;
      const entries = readAll(storage);
      if (ignoredJson.length > MAX_ENTRY_CHARACTERS) {
        // Refusing to grow without bound is better than evicting everything
        // else to hold one pathological document.
        delete entries[key];
      } else {
        entries[key] = { json: ignoredJson, savedAt: Date.now() };
      }
      writeAll(storage, entries);
    },
  };
}
