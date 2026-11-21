/**
 * Framework-neutral document persistence contracts.
 *
 * A DocumentSession owns one logical document at a time. Storage-specific
 * adapters implement DocumentCommitTarget; the session owns revisions,
 * serialization, lifecycle transitions, and conflict state.
 */

import type { DocumentLineageRecord } from './lineage.js';
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

/**
 * Why text is being set aside instead of saved to the document:
 * - `local`: unsaved edits that lost to a version saved elsewhere.
 * - `draft`: a draft recovered from a previous session, in the same position.
 * - `premerge`: the text from just before an automatic merge, kept for undo.
 */
export type DocumentParkOrigin = 'local' | 'draft' | 'premerge';

export interface DocumentParkRequest {
  targetKey: string;
  /** The text to keep. */
  content: string;
  origin: DocumentParkOrigin;
  /** The document as last read from storage; an identical copy is not worth keeping. */
  currentContent: string | null;
}

export interface DocumentCommitTarget {
  readonly key: string;
  commit(request: DocumentCommitRequest): Promise<DocumentCommitResult | void>;
  /**
   * Optional. Keep a copy of text that is not going to be saved to the
   * document, somewhere the user can find it again. A target that offers this
   * lets the session combine separate edits by itself and lets the user leave
   * a document whose conflict is still open; without it, a conflict blocks
   * until the user chooses a version.
   */
  park?(request: DocumentParkRequest): Promise<void>;
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

/** Who saved a version that arrived from outside this session, where storage can say. */
export interface DocumentExternalOrigin {
  /** A device name, such as "Mike's MacBook Pro". */
  savedBy?: string;
  modifiedAt?: number;
}

export interface DocumentExternalSnapshot {
  /** Target key captured before the external read began. */
  targetKey: string;
  /** Monotonic observation number assigned by the target watcher. */
  sequence?: number;
  /** Null represents an externally deleted document. */
  content: string | null;
  version?: DocumentExternalVersion;
  origin?: DocumentExternalOrigin;
}

export interface DocumentSessionConflict {
  /** The local branch was restored from a previous session's recovery journal. */
  recoveredDraft?: boolean;
  /** Capture time of the recovered copy, not an acknowledgement of a file save. */
  recoveredDraftCapturedAt?: number;
  targetKey: string;
  localContent: string;
  localRevision: number;
  /** Wall-clock time of this session's latest local edit, when it made one. */
  localEditedAt?: number;
  externalContent: string | null;
  externalVersion: DocumentExternalVersion;
  /**
   * The text both versions started from, for a three-way comparison. Null when
   * the document did not exist then; absent when this session does not know.
   */
  baseContent?: string | null;
  externalOrigin?: DocumentExternalOrigin;
  /**
   * The two versions change different parts of the document, and the session
   * is about to combine them by itself once typing pauses. Nothing needs the
   * user's attention while this is set.
   */
  merging?: boolean;
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
  /**
   * Whether edits made here and elsewhere to different parts of a document
   * are combined automatically. Needs a target that can `park`. Default true.
   */
  autoMergeEnabled?: boolean;
  /**
   * How long typing must pause before an automatic merge is applied: applying
   * it replaces the editor's content. Default 1500 ms.
   */
  autoMergeIdleMs?: number;
  /**
   * When storage hands over a version that was not built on the saves made
   * here, how long to wait for the sync service to show it set one of those
   * saves aside (which proves the two were written at the same time and may
   * be combined) before treating it as an ordinary newer version.
   * Default 2000 ms; 0 never waits.
   */
  concurrentSaveGraceMs?: number;
  /**
   * Optional device-local memory of what each document was last built on, so
   * a restart does not forget it. See DocumentLineageStore.
   */
  lineageStore?: DocumentLineageStorage | null;
}

/** Where a session keeps, per document, the text its last save was built on. */
export interface DocumentLineageStorage {
  read(targetKey: string): DocumentLineageRecord | null;
  /** Remember the record, or forget the document when it is null. */
  write(targetKey: string, record: DocumentLineageRecord | null): void;
}

/**
 * A version of the open document that a sync service set aside because it
 * was saved somewhere at the same time as the version that became the file.
 */
export interface DocumentConcurrentVersion {
  /** The document it is a version of; ignored when another one is open by now. */
  targetKey: string;
  content: string;
  /** When it was saved, by the saving device's clock. */
  savedAt?: number;
  origin?: DocumentExternalOrigin;
}

/**
 * What became of a set-aside version handed to the session:
 * - `merged`: its changes are now in the document (a `merged` event says so).
 * - `included`: the document already had everything in it.
 * - `review`: it cannot be combined safely; the user decides.
 * - `later`: not at this moment (typing, saving, an open conflict); ask again.
 */
export type DocumentAbsorbResult = 'merged' | 'included' | 'review' | 'later';

/** How eagerly unsaved edits are written. */
export interface DocumentAutoSavePacing {
  /** Quiet time after the last edit before saving. */
  delayMs: number;
  /**
   * The longest unsaved edits wait while typing never pauses that long. Null
   * or absent: no limit, the delay alone decides.
   */
  maxWaitMs?: number | null;
}

/** Something the session did by itself that the user should be told about. */
export type DocumentSessionEvent =
  | {
      /** Separate edits from here and elsewhere were combined into the document. */
      type: 'merged';
      targetKey: string;
      /** This session's text from before the merge, for undo. */
      localContent: string;
      externalContent: string;
      /** The combined text the document now holds. */
      mergedContent: string;
      externalOrigin?: DocumentExternalOrigin;
    }
  | {
      /** Unsaved text was set aside so the user could leave the document. */
      type: 'parked';
      targetKey: string;
      origin: DocumentParkOrigin;
    }
  | {
      /** A clean document was replaced with a newer version saved elsewhere. */
      type: 'external-applied';
      targetKey: string;
      externalOrigin?: DocumentExternalOrigin;
    };

export type DocumentSessionEventListener = (event: DocumentSessionEvent) => void;

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
export type DocumentConflictStrategy = 'use-local' | 'use-external' | 'use-merged';

export interface DocumentConflictResolution {
  /** Required by `use-merged`: the text that combines both versions. */
  content?: string;
}
