/**
 * Device-local memory of what each document was last built on.
 *
 * A session's lineage lives in memory, and a restart would otherwise begin
 * again from whatever the file holds. When that is this device's own last
 * save, the text it was built on is the one worth knowing: it is what a
 * device that never received the save is still working from. This keeps that
 * text, for a bounded number of documents, in the same synchronous storage
 * the recovery journal uses. Everything is best effort: a record that cannot
 * be kept or read back only means the next session starts from the file.
 */

import { textSignature, type DocumentLineageRecord } from './lineage.js';
import type { DocumentRecoveryStorage } from './recovery-journal.js';
import type { DocumentLineageStorage } from './types.js';

export const DOCUMENT_LINEAGE_STORAGE_KEY = 'docblocks:document-lineage:v1';

export interface DocumentLineageStoreOptions {
  storageKey?: string;
  /** Documents remembered at once; the least recently saved goes first. Default 12. */
  maxDocuments?: number;
  /**
   * Total text kept across documents, in UTF-16 units. Default 600,000: the
   * storage is shared with the recovery journal, whose drafts matter more.
   */
  maxChars?: number;
  /** A document longer than this is not remembered. Default 200,000. */
  maxRecordChars?: number;
  now?: () => number;
}

interface IndexEntry {
  targetKey: string;
  /** Storage key of the item holding the base text. */
  slot: string;
  baseSignature: string;
  baseKind: 'opened' | 'outside';
  baseAt: number;
  lastSaved: string;
  lastSavedAt: number;
  chars: number;
  updatedAt: number;
}

interface Index {
  schemaVersion: 1;
  entries: IndexEntry[];
}

function isIndexEntry(value: unknown): value is IndexEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.targetKey === 'string' &&
    typeof entry.slot === 'string' &&
    typeof entry.baseSignature === 'string' &&
    (entry.baseKind === 'opened' || entry.baseKind === 'outside') &&
    typeof entry.baseAt === 'number' &&
    Number.isFinite(entry.baseAt) &&
    typeof entry.lastSaved === 'string' &&
    typeof entry.lastSavedAt === 'number' &&
    Number.isFinite(entry.lastSavedAt) &&
    typeof entry.chars === 'number' &&
    typeof entry.updatedAt === 'number'
  );
}

export class DocumentLineageStore implements DocumentLineageStorage {
  private readonly storageKey: string;
  private readonly maxDocuments: number;
  private readonly maxChars: number;
  private readonly maxRecordChars: number;
  private readonly now: () => number;
  private slotCounter = 0;

  public constructor(
    private readonly storage: DocumentRecoveryStorage | null,
    options: DocumentLineageStoreOptions = {},
  ) {
    this.storageKey = options.storageKey ?? DOCUMENT_LINEAGE_STORAGE_KEY;
    this.maxDocuments = Math.max(1, options.maxDocuments ?? 12);
    this.maxChars = Math.max(1, options.maxChars ?? 600_000);
    this.maxRecordChars = Math.max(1, options.maxRecordChars ?? 200_000);
    this.now = options.now ?? Date.now;
  }

  public read(targetKey: string): DocumentLineageRecord | null {
    if (!this.storage) return null;
    try {
      const entry = this.load().entries.find((candidate) => candidate.targetKey === targetKey);
      if (!entry) return null;
      const base = this.storage.getItem(entry.slot);
      if (base === null || textSignature(base) !== entry.baseSignature) return null;
      return {
        base,
        baseKind: entry.baseKind,
        baseAt: entry.baseAt,
        lastSaved: entry.lastSaved,
        lastSavedAt: entry.lastSavedAt,
      };
    } catch {
      return null;
    }
  }

  /** Remember `record` for the document, or forget the document when it is null. */
  public write(targetKey: string, record: DocumentLineageRecord | null): void {
    if (!this.storage) return;
    try {
      const index = this.load();
      const position = index.entries.findIndex((candidate) => candidate.targetKey === targetKey);
      const existing = position < 0 ? null : index.entries[position]!;
      if (!record || record.base.length > this.maxRecordChars) {
        if (!existing) return;
        index.entries.splice(position, 1);
        this.storage.removeItem(existing.slot);
        this.save(index);
        return;
      }

      const baseSignature = textSignature(record.base);
      const entry: IndexEntry = {
        targetKey,
        slot: existing?.slot ?? this.newSlot(),
        baseSignature,
        baseKind: record.baseKind,
        baseAt: record.baseAt,
        lastSaved: record.lastSaved,
        lastSavedAt: record.lastSavedAt,
        chars: record.base.length,
        updatedAt: this.now(),
      };
      if (
        existing &&
        existing.baseSignature === baseSignature &&
        existing.baseKind === entry.baseKind &&
        existing.baseAt === entry.baseAt &&
        existing.lastSaved === entry.lastSaved
      ) {
        return;
      }
      if (existing) index.entries.splice(position, 1);
      this.evict(index, entry.chars);
      if (existing?.baseSignature !== baseSignature) {
        try {
          this.storage.setItem(entry.slot, record.base);
        } catch {
          // No room even after making some: go without this document.
          this.storage.removeItem(entry.slot);
          this.save(index);
          return;
        }
      }
      index.entries.push(entry);
      this.save(index);
    } catch {
      // Best effort: the next session starts from the file.
    }
  }

  private newSlot(): string {
    this.slotCounter += 1;
    return `${this.storageKey}:${this.now().toString(36)}-${this.slotCounter.toString(36)}-${Math.floor(
      Math.random() * 0x7fffffff,
    ).toString(36)}`;
  }

  /** Make room for `incoming` more characters, dropping the least recently saved first. */
  private evict(index: Index, incoming: number): void {
    index.entries.sort((a, b) => a.updatedAt - b.updatedAt);
    const total = () => index.entries.reduce((sum, entry) => sum + entry.chars, 0);
    while (
      index.entries.length > 0 &&
      (index.entries.length >= this.maxDocuments || total() + incoming > this.maxChars)
    ) {
      const dropped = index.entries.shift()!;
      this.storage?.removeItem(dropped.slot);
    }
  }

  private load(): Index {
    const raw = this.storage?.getItem(this.storageKey) ?? null;
    if (raw === null) return { schemaVersion: 1, entries: [] };
    try {
      const parsed = JSON.parse(raw) as { schemaVersion?: unknown; entries?: unknown };
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) {
        return { schemaVersion: 1, entries: [] };
      }
      return { schemaVersion: 1, entries: parsed.entries.filter(isIndexEntry) };
    } catch {
      return { schemaVersion: 1, entries: [] };
    }
  }

  private save(index: Index): void {
    this.storage?.setItem(this.storageKey, JSON.stringify(index));
  }
}
