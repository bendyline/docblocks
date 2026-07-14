/**
 * Framework-neutral document persistence contracts.
 *
 * A DocumentSession owns one logical document at a time. Storage-specific
 * adapters implement DocumentCommitTarget; the session owns revisions,
 * serialization, lifecycle transitions, and conflict state.
 */

import type { DocumentRecoveryJournal } from './recovery-journal.js';

export type DocumentSaveReason =
  | 'autosave'
  | 'manual'
  | 'transition'
  | 'close'
  | 'backup'
  | 'conflict';

export type DocumentExternalVersion = string | number | null;

export interface DocumentCommitRequest {
  /** Stable key for the target this commit was created for. */
  targetKey: string;
  /** Latest complete document snapshot to persist. */
  content: string;
  /** Monotonic session revision represented by content. */
  revision: number;
  /** Most recent revision acknowledged by this target. */
  persistedRevision: number;
  /** Content last acknowledged by the target, or null if it did not exist. */
  persistedContent: string | null;
  reason: DocumentSaveReason;
}

export interface DocumentCommitResult {
  /** Optional backend version (mtime, TextDocument.version, etag, and so on). */
  version?: DocumentExternalVersion;
}

export interface DocumentCommitTarget {
  readonly key: string;
  commit(request: DocumentCommitRequest): Promise<DocumentCommitResult | void>;
}

export type DocumentSessionStatus =
  | 'idle'
  | 'saved'
  | 'dirty'
  | 'saving'
  | 'error'
  | 'conflict'
  | 'closed';

export type DocumentSessionLifecycle = 'open' | 'transitioning' | 'closing' | 'closed';

export interface DocumentExternalSnapshot {
  /** Target key captured before the external read began. */
  targetKey: string;
  /** Monotonic observation number assigned by the target watcher. */
  sequence?: number;
  /** Null represents an externally deleted document. */
  content: string | null;
  version?: DocumentExternalVersion;
}

export interface DocumentSessionConflict {
  targetKey: string;
  localContent: string;
  localRevision: number;
  externalContent: string | null;
  externalVersion: DocumentExternalVersion;
}

export interface DocumentSessionSnapshot {
  targetKey: string | null;
  content: string;
  revision: number;
  persistedRevision: number;
  persistedContent: string | null;
  savingRevision: number | null;
  generation: number;
  status: DocumentSessionStatus;
  lifecycle: DocumentSessionLifecycle;
  frozen: boolean;
  error: Error | null;
  conflict: DocumentSessionConflict | null;
}

export interface DocumentSessionOptions {
  autoSaveDelayMs?: number;
  /** Whether edits schedule automatic persistence. Manual and lifecycle flushes remain available. */
  autoSaveEnabled?: boolean;
  /**
   * Bounded delays used after an automatic save fails. Each entry permits
   * one retry; exhausting the list leaves the session in error state until
   * the user edits again or explicitly flushes it. Conflicts never retry.
   */
  autoSaveRetryDelaysMs?: readonly number[];
  /** Optional synchronous crash-recovery journal owned by this session. */
  recoveryJournal?: DocumentRecoveryJournal | null;
}

/** Scope captured by an editor instance when it mounts. */
export interface DocumentSessionEditScope {
  targetKey: string;
  generation: number;
}

/** Result produced while a session transition is frozen. */
export interface DocumentSessionTransition {
  target: DocumentCommitTarget | null;
  content: string;
}

export type DocumentExternalChangeResult = 'applied' | 'conflict' | 'ignored';
export type DocumentConflictStrategy = 'use-local' | 'use-external';
