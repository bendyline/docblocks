/**
 * Synchronous crash-recovery journal for dirty document snapshots.
 *
 * The journal deliberately depends on a tiny injected Storage-like contract
 * instead of reading `window.localStorage` at module load time. This keeps the
 * document package usable in Node, Electron main, VS Code extension hosts, and
 * tests while allowing browser renderers to use localStorage for a best-effort
 * write that completes before the current JavaScript turn ends.
 */

export const DOCUMENT_RECOVERY_JOURNAL_STORAGE_KEY = 'docblocks:document-recovery:v1';
export const DOCUMENT_RECOVERY_JOURNAL_SCHEMA_VERSION = 1;

export interface DocumentRecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface DocumentRecoveryRecord {
  /** Stable commit-target key, including the workspace/provider scope. */
  targetKey: string;
  /** DocumentSession generation that produced this snapshot. */
  generation: number;
  /** Monotonic DocumentSession revision represented by `content`. */
  revision: number;
  /** Complete markdown snapshot. */
  content: string;
  /**
   * Content last acknowledged by the commit target when this draft was made.
   * Recovery may be applied automatically only when storage still matches this
   * baseline; otherwise the caller must surface an external-change conflict.
   */
  persistedContent: string | null;
  /** Time the dirty record for this target was first created. */
  createdAt: number;
  /** Time the record was most recently replaced. */
  updatedAt: number;
}

export interface DocumentRecoveryWrite {
  targetKey: string;
  generation: number;
  revision: number;
  content: string;
  persistedContent: string | null;
}

export interface DocumentRecoveryAcknowledgement {
  targetKey: string;
  generation: number;
  /** Highest revision durably acknowledged by the commit target. */
  persistedRevision: number;
}

export type DocumentRecoveryWriteFailure =
  | 'invalid-record'
  | 'record-too-large'
  | 'storage-unavailable'
  | 'quota-exceeded';

export type DocumentRecoveryWriteResult =
  | { status: 'stored'; evicted: number }
  | { status: 'unchanged'; evicted: 0 }
  | { status: 'ignored-stale'; evicted: 0 }
  | { status: 'rejected'; reason: DocumentRecoveryWriteFailure; evicted: number };

export interface DocumentRecoveryJournalOptions {
  storageKey?: string;
  /** Maximum number of document records retained. Defaults to 20. */
  maxEntries?: number;
  /** Conservative UTF-16 estimate for the whole serialized journal. */
  maxStorageBytes?: number;
  /** Conservative UTF-16 estimate for one serialized record. */
  maxRecordBytes?: number;
  /** Records older than this are discarded while reading. Defaults to 7 days. */
  maxAgeMs?: number;
  /** Tolerated clock skew for records dated in the future. Defaults to 5 minutes. */
  maxFutureSkewMs?: number;
  /** Injected for deterministic tests. */
  now?: () => number;
}

interface DocumentRecoveryEnvelope {
  schemaVersion: typeof DOCUMENT_RECOVERY_JOURNAL_SCHEMA_VERSION;
  records: DocumentRecoveryRecord[];
}

interface LoadedRecords {
  records: DocumentRecoveryRecord[];
  needsRepair: boolean;
}

interface PersistResult {
  stored: boolean;
  evicted: number;
  reason?: 'storage-unavailable' | 'quota-exceeded';
}

const DEFAULT_MAX_ENTRIES = 20;
const DEFAULT_MAX_STORAGE_BYTES = 2_000_000;
const DEFAULT_MAX_RECORD_BYTES = 1_000_000;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_TARGET_KEY_LENGTH = 4096;

/**
 * Best-effort, synchronous recovery storage.
 *
 * Normal save acknowledgement is the only automatic path that removes the
 * current record. Explicit discard, age expiry, corruption repair, and bounded
 * eviction are intentional exceptions: callers can discard after the user
 * rejects recovery, and the journal must never grow without limit.
 */
export class DocumentRecoveryJournal {
  private readonly storage: DocumentRecoveryStorage | null;
  private readonly storageKey: string;
  private readonly maxEntries: number;
  private readonly maxStorageBytes: number;
  private readonly maxRecordBytes: number;
  private readonly maxAgeMs: number;
  private readonly maxFutureSkewMs: number;
  private readonly now: () => number;

  public constructor(
    storage: DocumentRecoveryStorage | null,
    options: DocumentRecoveryJournalOptions = {},
  ) {
    this.storage = storage;
    this.storageKey = options.storageKey?.trim() || DOCUMENT_RECOVERY_JOURNAL_STORAGE_KEY;
    this.maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES);
    this.maxStorageBytes = positiveInteger(options.maxStorageBytes, DEFAULT_MAX_STORAGE_BYTES);
    this.maxRecordBytes = Math.min(
      positiveInteger(options.maxRecordBytes, DEFAULT_MAX_RECORD_BYTES),
      this.maxStorageBytes,
    );
    this.maxAgeMs = nonNegativeFinite(options.maxAgeMs, DEFAULT_MAX_AGE_MS);
    this.maxFutureSkewMs = nonNegativeFinite(options.maxFutureSkewMs, DEFAULT_MAX_FUTURE_SKEW_MS);
    this.now = options.now ?? Date.now;
  }

  /**
   * Synchronously persist the latest dirty snapshot for a target.
   * Storage/quota failures are returned, never thrown into an editor onChange.
   */
  public write(input: DocumentRecoveryWrite): DocumentRecoveryWriteResult {
    const timestamp = this.now();
    if (!isValidWrite(input) || !Number.isFinite(timestamp) || timestamp < 0) {
      return { status: 'rejected', reason: 'invalid-record', evicted: 0 };
    }
    if (!this.storage) {
      return { status: 'rejected', reason: 'storage-unavailable', evicted: 0 };
    }
    if (
      estimatedBytes(input.content) > this.maxRecordBytes ||
      (input.persistedContent !== null &&
        estimatedBytes(input.persistedContent) > this.maxRecordBytes)
    ) {
      return { status: 'rejected', reason: 'record-too-large', evicted: 0 };
    }

    const loaded = this.load(timestamp);
    const existing = loaded.records.find((record) => record.targetKey === input.targetKey);
    if (existing) {
      const ordering = compareGenerationRevision(input, existing);
      if (ordering < 0) return { status: 'ignored-stale', evicted: 0 };
      if (ordering === 0) {
        if (
          existing.content === input.content &&
          existing.persistedContent === input.persistedContent
        ) {
          return { status: 'unchanged', evicted: 0 };
        }
        // A revision is an immutable content snapshot. Reusing it for different
        // content would make acknowledgement and recovery ambiguous.
        return { status: 'rejected', reason: 'invalid-record', evicted: 0 };
      }
    }

    const candidate: DocumentRecoveryRecord = {
      targetKey: input.targetKey,
      generation: input.generation,
      revision: input.revision,
      content: input.content,
      persistedContent: input.persistedContent,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    if (estimatedBytes(JSON.stringify(candidate)) > this.maxRecordBytes) {
      return { status: 'rejected', reason: 'record-too-large', evicted: 0 };
    }
    if (estimatedBytes(serializeEnvelope([candidate])) > this.maxStorageBytes) {
      return { status: 'rejected', reason: 'record-too-large', evicted: 0 };
    }

    const next = loaded.records.filter((record) => record.targetKey !== input.targetKey);
    next.push(candidate);
    const persisted = this.persistBounded(next, input.targetKey);
    if (!persisted.stored) {
      return {
        status: 'rejected',
        reason: persisted.reason ?? 'quota-exceeded',
        evicted: persisted.evicted,
      };
    }
    return { status: 'stored', evicted: persisted.evicted };
  }

  /** Return the recoverable snapshot for one target, if present and valid. */
  public lookup(targetKey: string, generation?: number): DocumentRecoveryRecord | null {
    if (!isValidTargetKey(targetKey) || !isOptionalGeneration(generation)) return null;
    const record = this.load(this.now()).records.find(
      (candidate) =>
        candidate.targetKey === targetKey &&
        (generation === undefined || candidate.generation === generation),
    );
    return record ? cloneRecord(record) : null;
  }

  /** List valid records, newest first. Optionally restrict to one target. */
  public list(targetKey?: string): DocumentRecoveryRecord[] {
    if (targetKey !== undefined && !isValidTargetKey(targetKey)) return [];
    return this.load(this.now())
      .records.filter((record) => targetKey === undefined || record.targetKey === targetKey)
      .sort(compareNewestFirst)
      .map(cloneRecord);
  }

  /**
   * Clear a record only when the same generation has durably acknowledged at
   * least the journaled revision. A stale acknowledgement cannot erase a newer
   * crash-recovery snapshot.
   */
  public acknowledge(input: DocumentRecoveryAcknowledgement): boolean {
    if (!isValidAcknowledgement(input) || !this.storage) return false;
    const records = this.load(this.now()).records;
    const record = records.find((candidate) => candidate.targetKey === input.targetKey);
    if (
      !record ||
      record.generation !== input.generation ||
      record.revision > input.persistedRevision
    ) {
      return false;
    }

    return this.persistExact(records.filter((candidate) => candidate !== record));
  }

  /** Explicitly discard recovery data after a user or lifecycle decision. */
  public discard(targetKey: string, generation?: number): boolean {
    if (!isValidTargetKey(targetKey) || !isOptionalGeneration(generation) || !this.storage) {
      return false;
    }
    const records = this.load(this.now()).records;
    const next = records.filter(
      (record) =>
        record.targetKey !== targetKey ||
        (generation !== undefined && record.generation !== generation),
    );
    if (next.length === records.length) return false;
    return this.persistExact(next);
  }

  private load(timestamp: number): LoadedRecords {
    if (!this.storage) return { records: [], needsRepair: false };

    let raw: string | null;
    try {
      raw = this.storage.getItem(this.storageKey);
    } catch {
      return { records: [], needsRepair: false };
    }
    if (raw === null) return { records: [], needsRepair: false };

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      this.tryRemove();
      return { records: [], needsRepair: true };
    }
    if (!isEnvelope(parsed)) {
      this.tryRemove();
      return { records: [], needsRepair: true };
    }

    const byTarget = new Map<string, DocumentRecoveryRecord>();
    let needsRepair = estimatedBytes(raw) > this.maxStorageBytes;
    for (const candidate of parsed.records) {
      if (!isValidStoredRecord(candidate, timestamp, this.maxAgeMs, this.maxFutureSkewMs)) {
        needsRepair = true;
        continue;
      }
      if (estimatedBytes(JSON.stringify(candidate)) > this.maxRecordBytes) {
        needsRepair = true;
        continue;
      }
      const current = byTarget.get(candidate.targetKey);
      if (!current || compareStoredRecords(candidate, current) > 0) {
        if (current) needsRepair = true;
        byTarget.set(candidate.targetKey, cloneRecord(candidate));
      } else {
        needsRepair = true;
      }
    }

    const records = [...byTarget.values()].sort(compareNewestFirst);
    while (records.length > this.maxEntries) {
      records.pop();
      needsRepair = true;
    }
    while (
      records.length > 0 &&
      estimatedBytes(serializeEnvelope(records)) > this.maxStorageBytes
    ) {
      records.pop();
      needsRepair = true;
    }
    if (needsRepair) {
      // Best effort only. Read APIs must still return the validated in-memory
      // records even when storage is temporarily unavailable.
      this.persistBounded(records);
    }
    return { records, needsRepair };
  }

  private persistBounded(
    records: DocumentRecoveryRecord[],
    protectedTarget?: string,
  ): PersistResult {
    if (!this.storage) {
      return { stored: false, evicted: 0, reason: 'storage-unavailable' };
    }

    const next = [...records].sort(compareNewestFirst);
    let evicted = 0;
    while (next.length > this.maxEntries) {
      if (!evictOldest(next, protectedTarget)) break;
      evicted += 1;
    }

    let serialized = serializeEnvelope(next);
    while (estimatedBytes(serialized) > this.maxStorageBytes) {
      if (!evictOldest(next, protectedTarget)) {
        return { stored: false, evicted, reason: 'quota-exceeded' };
      }
      evicted += 1;
      serialized = serializeEnvelope(next);
    }

    for (;;) {
      try {
        this.storage.setItem(this.storageKey, serialized);
        return { stored: true, evicted };
      } catch {
        if (!evictOldest(next, protectedTarget)) {
          return { stored: false, evicted, reason: 'quota-exceeded' };
        }
        evicted += 1;
        serialized = serializeEnvelope(next);
      }
    }
  }

  private persistExact(records: DocumentRecoveryRecord[]): boolean {
    if (!this.storage) return false;
    if (records.length === 0) {
      try {
        this.storage.removeItem(this.storageKey);
        return true;
      } catch {
        return false;
      }
    }
    try {
      this.storage.setItem(this.storageKey, serializeEnvelope(records));
      return true;
    } catch {
      return false;
    }
  }

  private tryRemove(): void {
    try {
      this.storage?.removeItem(this.storageKey);
    } catch {
      // Recovery is best effort; a denied cleanup must not fail application startup.
    }
  }
}

/**
 * Resolve browser localStorage on demand. Importing this module never touches
 * browser globals, and access errors (sandboxing/security settings) yield null.
 */
export function getDefaultDocumentRecoveryStorage(): DocumentRecoveryStorage | null {
  try {
    const candidate = Reflect.get(globalThis, 'localStorage') as unknown;
    if (!isStorage(candidate)) return null;
    return candidate;
  } catch {
    return null;
  }
}

function serializeEnvelope(records: DocumentRecoveryRecord[]): string {
  const envelope: DocumentRecoveryEnvelope = {
    schemaVersion: DOCUMENT_RECOVERY_JOURNAL_SCHEMA_VERSION,
    records,
  };
  return JSON.stringify(envelope);
}

/** localStorage quotas are commonly measured from UTF-16 storage usage. */
function estimatedBytes(value: string): number {
  return value.length * 2;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? (value as number) : fallback;
}

function nonNegativeFinite(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? -1) >= 0 ? (value as number) : fallback;
}

function isEnvelope(value: unknown): value is DocumentRecoveryEnvelope {
  if (!isObject(value)) return false;
  return (
    value.schemaVersion === DOCUMENT_RECOVERY_JOURNAL_SCHEMA_VERSION && Array.isArray(value.records)
  );
}

function isValidStoredRecord(
  value: unknown,
  timestamp: number,
  maxAgeMs: number,
  maxFutureSkewMs: number,
): value is DocumentRecoveryRecord {
  if (!isObject(value)) return false;
  if (
    !isValidTargetKey(value.targetKey) ||
    !isNonNegativeSafeInteger(value.generation) ||
    !isNonNegativeSafeInteger(value.revision) ||
    typeof value.content !== 'string' ||
    (value.persistedContent !== null && typeof value.persistedContent !== 'string') ||
    !isNonNegativeFiniteNumber(value.createdAt) ||
    !isNonNegativeFiniteNumber(value.updatedAt) ||
    value.createdAt > value.updatedAt
  ) {
    return false;
  }
  if (!Number.isFinite(timestamp) || timestamp < 0) return false;
  if (value.updatedAt > timestamp + maxFutureSkewMs) return false;
  return timestamp - value.updatedAt <= maxAgeMs;
}

function isValidWrite(value: DocumentRecoveryWrite): boolean {
  return (
    isValidTargetKey(value.targetKey) &&
    isNonNegativeSafeInteger(value.generation) &&
    isNonNegativeSafeInteger(value.revision) &&
    typeof value.content === 'string' &&
    (value.persistedContent === null || typeof value.persistedContent === 'string')
  );
}

function isValidAcknowledgement(value: DocumentRecoveryAcknowledgement): boolean {
  return (
    isValidTargetKey(value.targetKey) &&
    isNonNegativeSafeInteger(value.generation) &&
    isNonNegativeSafeInteger(value.persistedRevision)
  );
}

function isValidTargetKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TARGET_KEY_LENGTH;
}

function isOptionalGeneration(value: number | undefined): boolean {
  return value === undefined || isNonNegativeSafeInteger(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStorage(value: unknown): value is DocumentRecoveryStorage {
  if (!isObject(value)) return false;
  return (
    typeof value.getItem === 'function' &&
    typeof value.setItem === 'function' &&
    typeof value.removeItem === 'function'
  );
}

function compareGenerationRevision(
  left: Pick<DocumentRecoveryRecord, 'generation' | 'revision'>,
  right: Pick<DocumentRecoveryRecord, 'generation' | 'revision'>,
): number {
  if (left.generation !== right.generation) return left.generation - right.generation;
  return left.revision - right.revision;
}

function compareStoredRecords(left: DocumentRecoveryRecord, right: DocumentRecoveryRecord): number {
  return compareGenerationRevision(left, right) || left.updatedAt - right.updatedAt;
}

function compareNewestFirst(left: DocumentRecoveryRecord, right: DocumentRecoveryRecord): number {
  return right.updatedAt - left.updatedAt || right.revision - left.revision;
}

function cloneRecord(record: DocumentRecoveryRecord): DocumentRecoveryRecord {
  return { ...record };
}

function evictOldest(records: DocumentRecoveryRecord[], protectedTarget?: string): boolean {
  let oldestIndex = -1;
  for (let index = 0; index < records.length; index += 1) {
    if (records[index].targetKey === protectedTarget) continue;
    if (oldestIndex < 0 || compareNewestFirst(records[index], records[oldestIndex]) > 0) {
      oldestIndex = index;
    }
  }
  if (oldestIndex < 0) return false;
  records.splice(oldestIndex, 1);
  return true;
}
