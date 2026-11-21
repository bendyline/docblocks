import type {
  DocumentAbsorbResult,
  DocumentAutoSavePacing,
  DocumentCommitTarget,
  DocumentConcurrentVersion,
  DocumentConflictResolution,
  DocumentConflictStrategy,
  DocumentExternalChangeResult,
  DocumentExternalOrigin,
  DocumentExternalSnapshot,
  DocumentLineageStorage,
  DocumentSaveReason,
  DocumentSessionConflict,
  DocumentSessionEditScope,
  DocumentSessionEvent,
  DocumentSessionEventListener,
  DocumentSessionLifecycle,
  DocumentSessionOptions,
  DocumentSessionSnapshot,
  DocumentSessionStatus,
  DocumentSessionTransition,
} from './types.js';
import { isFileSystemMoveStateError } from '../filesystem/move-error.js';
import { DocumentLineage, type DocumentParting, type DocumentVersionOrigin } from './lineage.js';
import type { DocumentRecoveryJournal, DocumentRecoveryRecord } from './recovery-journal.js';
import { mergeText } from './three-way-merge.js';

type SessionListener = () => void;

const DEFAULT_AUTO_SAVE_RETRY_DELAYS_MS = [1_000, 3_000, 10_000] as const;
const DEFAULT_AUTO_MERGE_IDLE_MS = 1_500;
const DEFAULT_CONCURRENT_SAVE_GRACE_MS = 2_000;

/** How local text and a version that storage holds combine from where the two parted. */
interface ForkMerge {
  readonly merged: string;
  /** The sync service set a save made here aside: the two were written at the same time. */
  readonly proven: boolean;
  /** How much longer that proof is worth waiting for. */
  readonly waitMs: number;
}

/**
 * Raised by a commit target when optimistic external-change verification
 * fails. The session converts it into durable conflict state.
 */
export class DocumentCommitConflictError extends Error {
  public readonly externalContent: string | null;
  public readonly externalVersion: string | number | null;

  public constructor(
    message: string,
    externalContent: string | null,
    externalVersion: string | number | null = null,
  ) {
    super(message);
    this.name = 'DocumentCommitConflictError';
    this.externalContent = externalContent;
    this.externalVersion = externalVersion;
  }
}

export class DocumentSessionConflictError extends Error {
  public readonly conflict: DocumentSessionConflict;

  public constructor(conflict: DocumentSessionConflict) {
    super('The document changed outside DocBlocks while local edits were pending.');
    this.name = 'DocumentSessionConflictError';
    this.conflict = conflict;
  }
}

/**
 * A revisioned, serialized persistence boundary for one active document.
 *
 * Invariants:
 * - only drain() calls target.commit();
 * - at most one commit is in flight;
 * - revisions never decrease, including across target transitions;
 * - destructive operations wait for an in-flight commit and run last;
 * - a target is never changed by a React effect cleanup;
 * - text is never dropped by the session's own choice: before an automatic
 *   merge or a parked conflict replaces local text, the target has kept it.
 */
export class DocumentSession {
  private autoSaveDelayMs: number;
  private autoSaveMaxWaitMs: number | null = null;
  /** When the oldest edit that is still unsaved was made. */
  private unsavedSince: number | null = null;
  private readonly autoSaveRetryDelaysMs: readonly number[];
  private readonly recoveryJournal: DocumentRecoveryJournal | null;
  private recoveredRecords: DocumentRecoveryRecord[] = [];
  private readonly listeners = new Set<SessionListener>();
  private readonly eventListeners = new Set<DocumentSessionEventListener>();
  private readonly autoMergeEnabled: boolean;
  private readonly autoMergeIdleMs: number;
  private readonly concurrentSaveGraceMs: number;
  private autoMergeTimer: ReturnType<typeof setTimeout> | null = null;
  /** The outside version whose proof of being written at the same time is awaited, and since when. */
  private forkWait: {
    readonly external: string;
    readonly since: number;
  } | null = null;
  private partingMemo: {
    readonly external: string;
    readonly stamp: number;
    readonly parting: DocumentParting | null;
  } | null = null;
  private autoSaveEnabled: boolean;
  /** The texts this document has held here, for combining with a version saved elsewhere. */
  private readonly lineage = new DocumentLineage();
  private readonly lineageStore: DocumentLineageStorage | null;

  private target: DocumentCommitTarget | null = null;
  private content = '';
  private persistedContent: string | null = null;
  private revision = 0;
  private persistedRevision = 0;
  private savingRevision: number | null = null;
  private savingContent: string | null = null;
  private generation = 0;
  private externalSequence = -1;
  private lifecycle: DocumentSessionLifecycle = 'open';
  private frozen = false;
  private error: Error | null = null;
  private conflict: DocumentSessionConflict | null = null;
  private localEditedAt: number | undefined;

  private autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private autoSaveRetryAttempt = 0;
  private drainPromise: Promise<void> | null = null;
  private haltDrain = false;
  private operationTail: Promise<void> = Promise.resolve();
  private snapshot: DocumentSessionSnapshot;

  public constructor(options: DocumentSessionOptions = {}) {
    this.autoSaveDelayMs = Math.max(0, options.autoSaveDelayMs ?? 500);
    this.autoSaveEnabled = options.autoSaveEnabled ?? true;
    this.autoSaveRetryDelaysMs = normalizeRetryDelays(
      options.autoSaveRetryDelaysMs ?? DEFAULT_AUTO_SAVE_RETRY_DELAYS_MS,
    );
    this.recoveryJournal = options.recoveryJournal?.forOwner(crypto.randomUUID()) ?? null;
    this.autoMergeEnabled = options.autoMergeEnabled ?? true;
    this.autoMergeIdleMs = Math.max(0, options.autoMergeIdleMs ?? DEFAULT_AUTO_MERGE_IDLE_MS);
    this.concurrentSaveGraceMs = Math.max(
      0,
      options.concurrentSaveGraceMs ?? DEFAULT_CONCURRENT_SAVE_GRACE_MS,
    );
    this.lineageStore = options.lineageStore ?? null;
    this.snapshot = this.createSnapshot();
  }

  /**
   * Hear about what the session did by itself: a merge, text set aside, a
   * newer version adopted. State lives in the snapshot; these are the moments
   * worth a notice.
   */
  public readonly subscribeEvents = (listener: DocumentSessionEventListener): (() => void) => {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  };

  public readonly subscribe = (listener: SessionListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  public readonly getSnapshot = (): DocumentSessionSnapshot => this.snapshot;

  /**
   * Change how eagerly edits are saved. Storage that syncs keeps a version for
   * every save, and two devices saving twice a second is how one document
   * gains several losing versions; such storage is given a longer pause and a
   * limit on how long steady typing can go unsaved. Takes effect from the
   * next edit; an already scheduled save keeps its time.
   */
  public setAutoSavePacing(pacing: DocumentAutoSavePacing): void {
    if (!Number.isFinite(pacing.delayMs) || pacing.delayMs < 0) {
      throw new TypeError('The autosave delay must be a finite, non-negative number.');
    }
    const maxWait = pacing.maxWaitMs ?? null;
    if (maxWait !== null && (!Number.isFinite(maxWait) || maxWait < 0)) {
      throw new TypeError('The autosave limit must be a finite, non-negative number.');
    }
    this.autoSaveDelayMs = Math.floor(pacing.delayMs);
    this.autoSaveMaxWaitMs = maxWait === null ? null : Math.floor(maxWait);
  }

  /** Enable or disable automatic persistence without weakening explicit or lifecycle flushes. */
  public setAutoSaveEnabled(enabled: boolean): void {
    if (this.autoSaveEnabled === enabled) return;
    this.autoSaveEnabled = enabled;
    if (!enabled) {
      this.clearAutoSaveTimer();
      return;
    }
    if (
      this.target &&
      this.lifecycle === 'open' &&
      !this.frozen &&
      !this.conflict &&
      this.persistedRevision < this.revision
    ) {
      this.scheduleAutoSave();
    }
  }

  /**
   * Record a complete local snapshot and schedule its persistence.
   * Returns the assigned monotonic revision.
   */
  public edit(content: string, scope: DocumentSessionEditScope): number {
    if (!this.target || this.lifecycle !== 'open' || this.frozen) {
      throw new Error('Cannot edit a document session that is not open.');
    }
    if (scope.targetKey !== this.target.key || scope.generation !== this.generation) {
      throw new Error('Cannot apply an edit from an obsolete document instance.');
    }
    if (content === this.content) return this.revision;

    this.content = content;
    this.revision += 1;
    this.localEditedAt = Date.now();
    this.unsavedSince ??= this.localEditedAt;
    this.error = null;
    this.autoSaveRetryAttempt = 0;
    if (this.conflict) {
      this.conflict = this.withMergePlan({
        ...this.conflict,
        localContent: content,
        localRevision: this.revision,
        localEditedAt: this.localEditedAt,
      });
      this.scheduleAutoMerge();
    }
    this.writeRecoverySnapshot();
    if (!this.conflict) this.scheduleAutoSave();
    this.emit();
    return this.revision;
  }

  /**
   * Replace the whole document with other text, as one explicit user choice
   * (using a stored version, undoing a merge), and save it. The editor is
   * remounted on the new text. Refused while a conflict is open: that choice
   * belongs to resolveConflict.
   */
  public replaceContent(content: string): Promise<DocumentSessionSnapshot> {
    return this.enqueueOperation(async () => {
      if (!this.target || this.lifecycle !== 'open' || this.frozen) {
        throw new Error('Cannot replace the content of a document session that is not open.');
      }
      if (this.conflict) throw new DocumentSessionConflictError(this.conflict);
      if (content === this.content) return this.snapshot;
      this.clearAutoSaveTimer();
      this.content = content;
      this.revision += 1;
      this.generation += 1;
      this.localEditedAt = Date.now();
      this.error = null;
      this.autoSaveRetryAttempt = 0;
      this.writeRecoverySnapshot();
      this.emit();
      return this.flush('manual');
    });
  }

  /**
   * Take in a version of this document that a sync service set aside because
   * it was saved somewhere else at the same moment. Where the two change
   * different parts and what both started from is known, they are combined
   * and saved, the text from before is kept for undo, and a `merged` event
   * follows. Otherwise nothing changes and the answer says why.
   *
   * The set-aside version is the proof that neither save had seen the other,
   * which is what makes combining right: a plain newer version that lacks
   * something typed here may have removed it on purpose.
   */
  public absorbConcurrentVersion(
    version: DocumentConcurrentVersion,
  ): Promise<DocumentAbsorbResult> {
    return this.enqueueOperation(async () => {
      const target = this.target;
      if (!target || this.lifecycle !== 'open' || this.frozen) return 'later';
      if (version.targetKey !== target.key) return 'later';
      // A sync service sets a save aside only when another was made without
      // sight of it. For a save made here, that settles how to treat the
      // version that replaced it in storage: written at the same time, to be
      // combined with the typing here, not a newer version that removed it.
      if (
        this.lineage.sawSetAside(version.content, version.savedAt ?? null, Date.now()) &&
        this.conflict
      ) {
        this.conflict = this.withMergePlan(this.conflict);
        this.scheduleAutoMerge();
        this.emit();
      }
      // While the version in storage is still being dealt with, this one waits.
      if (this.conflict) return 'later';
      if (version.content === this.content) return 'included';
      if (!this.autoMergeEnabled || !target.park) return 'review';
      // Applying this remounts the editor, so it waits for a pause in typing.
      const typing = () =>
        this.localEditedAt !== undefined && Date.now() - this.localEditedAt < this.autoMergeIdleMs;
      if (typing()) return 'later';
      await this.awaitActiveDrain();
      if (
        this.target !== target ||
        this.lifecycle !== 'open' ||
        this.frozen ||
        this.conflict ||
        typing()
      ) {
        return 'later';
      }

      const mine = this.content;
      const plan = this.lineage.plan(
        mine,
        version.content,
        version.savedAt ?? null,
        version.origin?.savedBy,
      );
      if (plan.status === 'included') return 'included';
      if (plan.status !== 'merged') return 'review';
      try {
        await target.park({
          targetKey: target.key,
          content: mine,
          origin: 'premerge',
          currentContent: this.persistedContent,
        });
      } catch {
        // Never combine without the copy that undoes it.
        return 'later';
      }
      if (this.target !== target || this.conflict || this.content !== mine || this.frozen) {
        return 'later';
      }

      this.clearAutoSaveTimer();
      this.content = plan.merged;
      this.revision += 1;
      this.generation += 1;
      this.error = null;
      this.autoSaveRetryAttempt = 0;
      if (plan.foreign) {
        this.lineage.absorbed(version.content, version.savedAt ?? Date.now(), {
          setAside: true,
          by: version.origin?.savedBy,
          mine,
        });
      } else this.lineage.restored(version.content);
      this.writeRecoverySnapshot();
      this.emit();
      this.emitEvent({
        type: 'merged',
        targetKey: target.key,
        localContent: mine,
        externalContent: version.content,
        mergedContent: plan.merged,
        // A save of this session's own that storage had replaced has no other author to name.
        ...(plan.foreign && version.origin ? { externalOrigin: version.origin } : {}),
      });
      try {
        await this.flush('conflict');
      } catch {
        // As after any merge: a newer outside change is a new conflict, and an
        // ordinary write failure retries like any other save.
        if (!this.conflict && this.persistedRevision < this.revision) this.scheduleAutoSave();
      }
      return 'merged';
    });
  }

  /**
   * Persist the revision current when flush() is called. A later edit may
   * advance the session again, but commits remain strictly serialized.
   */
  public async flush(reason: DocumentSaveReason = 'manual'): Promise<DocumentSessionSnapshot> {
    this.clearAutoSaveTimer();
    if (!this.target) return this.snapshot;
    if (this.conflict) throw new DocumentSessionConflictError(this.conflict);

    const requiredRevision = this.revision;
    while (this.target && this.persistedRevision < requiredRevision) {
      if (this.conflict) throw new DocumentSessionConflictError(this.conflict);
      if (this.haltDrain) {
        throw new Error('Document persistence was cancelled before the requested revision saved.');
      }
      try {
        await this.ensureDrain(reason);
      } catch (error: unknown) {
        if (this.conflict) throw new DocumentSessionConflictError(this.conflict);
        throw error;
      }
    }

    if (this.conflict) throw new DocumentSessionConflictError(this.conflict);
    if (this.persistedRevision < requiredRevision) {
      throw new Error('The document target closed before the requested revision saved.');
    }
    return this.snapshot;
  }

  /**
   * Flush the old document, then replace it with a new clean baseline.
   * UI state should change only after this promise resolves.
   */
  public transitionTo(
    target: DocumentCommitTarget | null,
    content: string,
  ): Promise<DocumentSessionSnapshot> {
    return this.enqueueOperation(() =>
      this.performTransition(async () => ({ target, content })).then((snapshot) => {
        if (!snapshot) throw new Error('A fixed document transition cannot be cancelled.');
        return snapshot;
      }),
    );
  }

  /**
   * Freeze and flush the current document before reading the next one. The
   * loader may return null when a navigation request was superseded, leaving
   * the current target active and clean.
   */
  public transitionWithLoad(
    load: () => Promise<DocumentSessionTransition | null>,
  ): Promise<DocumentSessionSnapshot | null> {
    return this.enqueueOperation(() => this.performTransition(load));
  }

  /**
   * Flush the current path, run the storage move, and only then swap the
   * commit target. No edit can enter between those steps.
   */
  public retarget(
    nextTarget: DocumentCommitTarget,
    moveStorage: () => Promise<void>,
  ): Promise<DocumentSessionSnapshot> {
    return this.enqueueOperation(async () => {
      this.assertNotPreparingClose();
      if (!this.target) throw new Error('Cannot retarget a session without a document.');

      this.lifecycle = 'transitioning';
      this.frozen = true;
      this.emit();
      try {
        this.haltDrain = false;
        await this.flush('transition');
        const previousKey = this.target?.key;
        await moveStorage();
        this.generation += 1;
        this.externalSequence = -1;
        this.target = nextTarget;
        if (previousKey && previousKey !== nextTarget.key) this.forgetLineage(previousKey);
        this.rememberLineage();
        this.error = null;
        this.conflict = null;
        this.lifecycle = 'open';
        this.frozen = false;
        this.emit();
        return this.snapshot;
      } catch (error: unknown) {
        if (isFileSystemMoveStateError(error)) {
          if (error.documentLocation === 'destination') {
            this.generation += 1;
            this.externalSequence = -1;
            this.target = nextTarget;
          }
          this.haltDrain = true;
          this.error = error;
          this.lifecycle = 'open';
          // The provider could not establish one authoritative compound move.
          // Keep editing frozen until navigation/recovery chooses a real path.
          this.frozen = true;
          this.emit();
          throw error;
        }
        this.lifecycle = 'open';
        this.frozen = false;
        this.emit();
        throw error;
      }
    });
  }

  /**
   * Cancel queued writes, wait for an already-running write, then delete.
   * The deletion is therefore the final storage operation for this target.
   */
  public delete(deleteStorage: () => Promise<void>): Promise<DocumentSessionSnapshot> {
    return this.enqueueOperation(async () => {
      this.assertNotPreparingClose();
      this.lifecycle = 'transitioning';
      this.frozen = true;
      this.haltDrain = true;
      this.clearAutoSaveTimer();
      this.emit();

      await this.awaitActiveDrain();
      try {
        await deleteStorage();
      } catch (error: unknown) {
        this.haltDrain = false;
        this.lifecycle = 'open';
        this.frozen = false;
        if (this.target && this.persistedRevision < this.revision && !this.conflict) {
          this.scheduleAutoSave();
        }
        this.emit();
        throw error;
      }

      this.discardRecoverySnapshot();
      if (this.target) this.forgetLineage(this.target.key);
      this.detach();
      return this.snapshot;
    });
  }

  /**
   * Discard queued changes and detach without mutating storage. This is used
   * for explicitly abandoned sessions, never as an implicit effect cleanup.
   */
  public cancel(): Promise<DocumentSessionSnapshot> {
    return this.enqueueOperation(async () => {
      this.lifecycle = 'transitioning';
      this.frozen = true;
      this.haltDrain = true;
      this.clearAutoSaveTimer();
      this.emit();
      await this.awaitActiveDrain();
      this.discardRecoverySnapshot();
      this.detach();
      return this.snapshot;
    });
  }

  /**
   * Observe a filesystem/host change captured for targetKey. Clean sessions
   * adopt it. Dirty or saving sessions preserve local text and enter conflict.
   */
  public observeExternal(change: DocumentExternalSnapshot): DocumentExternalChangeResult {
    if (!this.target || change.targetKey !== this.target.key || this.lifecycle === 'closed') {
      return 'ignored';
    }
    if (change.sequence !== undefined) {
      if (!Number.isSafeInteger(change.sequence) || change.sequence <= this.externalSequence) {
        return 'ignored';
      }
      this.externalSequence = change.sequence;
    }

    // While conflicted, a current observation equal to the latest local
    // snapshot proves that revision durable without requiring another write.
    // Never acknowledge while a commit is still running; its eventual result
    // remains authoritative for the serialized drain.
    if (
      this.conflict &&
      change.content === this.content &&
      this.savingRevision === null &&
      this.lifecycle === 'open'
    ) {
      this.clearAutoSaveTimer();
      this.autoSaveRetryAttempt = 0;
      this.persistedRevision = this.revision;
      this.persistedContent = this.content;
      this.lineage.saved(this.content, Date.now());
      this.rememberLineage();
      this.haltDrain = false;
      this.error = null;
      this.conflict = null;
      this.discardRecoverySnapshot();
      this.emit();
      return 'applied';
    }

    // Once a conflict exists, every later accepted observation refreshes its
    // external branch before ordinary duplicate suppression. In particular,
    // A -> local C -> external B -> external A must offer A, not stale B, when
    // the user chooses Reload external.
    if (this.conflict) {
      const externalVersion = change.version ?? null;
      if (
        this.conflict.localContent === this.content &&
        this.conflict.localRevision === this.revision &&
        this.conflict.externalContent === change.content &&
        this.conflict.externalVersion === externalVersion
      ) {
        return 'ignored';
      }

      // Cloud-sync clients commonly publish a replacement as unlink + add.
      // A clean session may therefore observe a momentary deletion and enter
      // conflict before the replacement appears. If the local branch is still
      // exactly the persisted baseline, the later file is another clean
      // external observation: adopt it without writing the old bytes back.
      const localBranchIsStillClean =
        this.savingRevision === null &&
        this.lifecycle === 'open' &&
        this.persistedRevision === this.revision &&
        this.persistedContent === this.content &&
        this.conflict.localRevision === this.revision &&
        this.conflict.localContent === this.content;
      if (
        localBranchIsStillClean &&
        change.content !== null &&
        !this.holdsFor(change.content, change.origin)
      ) {
        this.adoptExternalContent(change.content, change.origin);
        return 'applied';
      }

      this.clearAutoSaveTimer();
      this.haltDrain = true;
      this.conflict = this.withMergePlan({
        ...this.conflict,
        targetKey: change.targetKey,
        localContent: this.content,
        localRevision: this.revision,
        localEditedAt: this.localEditedAt,
        externalContent: change.content,
        externalVersion,
        externalOrigin: change.origin,
      });
      this.error = null;
      this.writeRecoverySnapshot();
      this.scheduleAutoMerge();
      this.emit();
      return 'conflict';
    }

    if (
      change.content === this.content ||
      change.content === this.persistedContent ||
      (this.savingRevision !== null && change.content === this.savingContent)
    ) {
      return 'ignored';
    }

    const isClean =
      this.persistedRevision === this.revision &&
      this.savingRevision === null &&
      this.error === null &&
      this.conflict === null;

    // A version that carries none of the saves made here may have been
    // written at the same time as them. Taking it at once would make that
    // typing vanish, to be put back a moment later when its set-aside copy
    // turns up; holding it for that moment lets the two be combined in one
    // step. With no copy, it is taken as the newer version it then is.
    if (isClean && change.content !== null && !this.holdsFor(change.content, change.origin)) {
      this.adoptExternalContent(change.content, change.origin);
      return 'applied';
    }

    this.clearAutoSaveTimer();
    this.haltDrain = true;
    this.conflict = this.withMergePlan({
      targetKey: change.targetKey,
      localContent: this.content,
      localRevision: this.revision,
      localEditedAt: this.localEditedAt,
      externalContent: change.content,
      externalVersion: change.version ?? null,
      baseContent: this.persistedContent,
      externalOrigin: change.origin,
    });
    this.error = null;
    this.writeRecoverySnapshot();
    this.scheduleAutoMerge();
    this.emit();
    return 'conflict';
  }

  private adoptExternalContent(content: string, origin?: DocumentExternalOrigin): void {
    const targetKey = this.target?.key;
    this.clearAutoMergeTimer();
    this.clearAutoSaveTimer();
    this.autoSaveRetryAttempt = 0;
    this.content = content;
    this.localEditedAt = undefined;
    this.unsavedSince = null;
    this.revision += 1;
    this.persistedRevision = this.revision;
    this.persistedContent = content;
    this.tookOutside(content, origin);
    this.generation += 1;
    this.haltDrain = false;
    this.error = null;
    this.conflict = null;
    this.discardRecoverySnapshot();
    this.emit();
    if (targetKey) {
      this.emitEvent({
        type: 'external-applied',
        targetKey,
        ...(origin ? { externalOrigin: origin } : {}),
      });
    }
  }

  public resolveConflict(
    strategy: DocumentConflictStrategy,
    resolution: DocumentConflictResolution = {},
  ): Promise<DocumentSessionSnapshot> {
    return this.enqueueOperation(async () => {
      if (!this.conflict) return this.snapshot;
      if (strategy === 'use-merged' && typeof resolution.content !== 'string') {
        throw new TypeError('Resolving with a merged version needs the merged text.');
      }

      this.clearAutoMergeTimer();
      this.clearAutoSaveTimer();
      this.haltDrain = true;
      await this.awaitActiveDrain();
      // A watcher may refresh or converge the conflict while an in-flight
      // commit settles. Resolve the branch that is current now, never the
      // snapshot captured before the await.
      const currentConflict = this.conflict;
      if (!currentConflict) return this.snapshot;

      if (strategy === 'use-external') {
        this.discardRecoverySnapshot();
        this.generation += 1;
        this.revision += 1;
        this.localEditedAt = undefined;
        this.unsavedSince = null;
        this.conflict = null;
        this.error = null;
        this.haltDrain = false;

        if (currentConflict.externalContent === null) {
          this.target = null;
          this.content = '';
          this.persistedContent = null;
          this.persistedRevision = this.revision;
          this.lifecycle = 'closed';
          this.frozen = true;
        } else {
          this.content = currentConflict.externalContent;
          this.persistedContent = currentConflict.externalContent;
          this.tookOutside(currentConflict.externalContent, currentConflict.externalOrigin);
          this.persistedRevision = this.revision;
          this.lifecycle = 'open';
          this.frozen = false;
        }
        this.emit();
        return this.snapshot;
      }

      if (strategy === 'use-merged') {
        // The combined text replaces what the editor holds, so it remounts.
        this.content = resolution.content!;
        this.generation += 1;
        this.localEditedAt = Date.now();
      }
      // Keep the local branch, but make the observed external snapshot the
      // optimistic baseline for the next conditional commit.
      this.persistedContent = currentConflict.externalContent;
      if (currentConflict.externalContent !== null) {
        this.tookOutside(currentConflict.externalContent, currentConflict.externalOrigin);
      }
      // A clean external deletion/conflict has no unsaved local revision.
      // Keeping local still requires a fresh commit that recreates/overwrites
      // the target, so make that intent explicit with a new revision.
      this.revision += 1;
      this.conflict = null;
      this.error = null;
      this.haltDrain = false;
      this.lifecycle = 'open';
      this.frozen = false;
      this.writeRecoverySnapshot();
      this.emit();
      return this.flush('conflict');
    });
  }

  /**
   * Freeze edits and flush through the latest revision. A successful call
   * remains frozen until cancelClose(); the owning host may now destroy it.
   */
  public prepareClose(): Promise<DocumentSessionSnapshot> {
    return this.enqueueOperation(async () => {
      if (this.lifecycle === 'closing') return this.snapshot;
      this.lifecycle = 'closing';
      this.frozen = true;
      this.emit();
      try {
        await this.settleConflictBeforeLeaving();
        this.haltDrain = false;
        await this.flush('close');
        return this.snapshot;
      } catch (error: unknown) {
        this.lifecycle = 'open';
        this.frozen = false;
        this.emit();
        throw error;
      }
    });
  }

  /** Resume editing when a host cancels a prepared close. */
  public cancelClose(): void {
    if (this.lifecycle !== 'closing') return;
    this.lifecycle = 'open';
    this.frozen = false;
    this.haltDrain = false;
    if (this.target && this.persistedRevision < this.revision && !this.conflict) {
      this.scheduleAutoSave();
    }
    this.emit();
  }

  private async performTransition(
    load: () => Promise<DocumentSessionTransition | null>,
  ): Promise<DocumentSessionSnapshot | null> {
    this.assertNotPreparingClose();
    this.lifecycle = 'transitioning';
    this.frozen = true;
    this.emit();

    try {
      await this.settleConflictBeforeLeaving();
      this.haltDrain = false;
      await this.flush('transition');
      this.clearAutoSaveTimer();
      const next = await load();
      if (!next) {
        this.lifecycle = 'open';
        this.frozen = false;
        this.emit();
        return null;
      }

      this.generation += 1;
      this.externalSequence = -1;
      this.target = next.target;
      this.content = next.content;
      this.localEditedAt = undefined;
      this.unsavedSince = null;
      this.revision += 1;
      this.persistedRevision = this.revision;
      this.persistedContent = next.target ? next.content : null;
      this.openLineage(next.target ? next.content : null);
      this.savingRevision = null;
      this.savingContent = null;
      this.error = null;
      this.conflict = null;
      this.haltDrain = false;
      this.lifecycle = 'open';
      this.frozen = false;
      const recoveryState = this.restoreRecoverySnapshot();
      if (recoveryState === 'dirty') this.scheduleAutoSave();
      this.emit();
      return this.snapshot;
    } catch (error: unknown) {
      this.lifecycle = 'open';
      this.frozen = false;
      this.emit();
      throw error;
    }
  }

  private scheduleAutoSave(retryDelayMs?: number): void {
    this.clearAutoSaveTimer();
    if (!this.autoSaveEnabled) return;
    let delayMs = retryDelayMs ?? this.autoSaveDelayMs;
    if (
      retryDelayMs === undefined &&
      this.autoSaveMaxWaitMs !== null &&
      this.unsavedSince !== null
    ) {
      // Steady typing keeps pushing the pause back; this is where it stops.
      const due = this.unsavedSince + this.autoSaveMaxWaitMs - Date.now();
      delayMs = Math.min(delayMs, Math.max(0, due));
    }
    this.autoSaveTimer = setTimeout(() => {
      this.autoSaveTimer = null;
      const target = this.target;
      const generation = this.generation;
      void this.flush('autosave').then(
        () => {
          this.autoSaveRetryAttempt = 0;
        },
        () => {
          // Preserve honest error/conflict state while making ordinary I/O
          // failures recoverable. A newer edit already owns a fresh debounce
          // timer, and lifecycle operations cancel this retry path.
          if (
            this.autoSaveTimer !== null ||
            !target ||
            target !== this.target ||
            generation !== this.generation ||
            this.lifecycle !== 'open' ||
            this.frozen ||
            this.haltDrain ||
            this.conflict ||
            this.persistedRevision >= this.revision
          ) {
            return;
          }
          const retryDelay = this.autoSaveRetryDelaysMs[this.autoSaveRetryAttempt];
          if (retryDelay === undefined) return;
          this.autoSaveRetryAttempt += 1;
          this.scheduleAutoSave(retryDelay);
        },
      );
    }, delayMs);
  }

  private clearAutoSaveTimer(): void {
    if (this.autoSaveTimer === null) return;
    clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = null;
  }

  private ensureDrain(reason: DocumentSaveReason): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    const running = this.drain(reason);
    this.drainPromise = running;
    const clear = () => {
      if (this.drainPromise === running) this.drainPromise = null;
    };
    void running.then(clear, clear);
    return running;
  }

  private async drain(reason: DocumentSaveReason): Promise<void> {
    while (
      this.target &&
      !this.haltDrain &&
      !this.conflict &&
      this.persistedRevision < this.revision
    ) {
      const target = this.target;
      const generation = this.generation;
      const saveRevision = this.revision;
      const saveContent = this.content;
      const previousPersistedRevision = this.persistedRevision;
      const previousPersistedContent = this.persistedContent;

      this.savingRevision = saveRevision;
      this.savingContent = saveContent;
      this.error = null;
      this.emit();

      try {
        await target.commit({
          targetKey: target.key,
          content: saveContent,
          revision: saveRevision,
          persistedRevision: previousPersistedRevision,
          persistedContent: previousPersistedContent,
          reason,
        });
      } catch (error: unknown) {
        this.savingRevision = null;
        this.savingContent = null;
        if (error instanceof DocumentCommitConflictError) {
          this.haltDrain = true;
          this.conflict = this.withMergePlan({
            targetKey: target.key,
            localContent: this.content,
            localRevision: this.revision,
            localEditedAt: this.localEditedAt,
            externalContent: error.externalContent,
            externalVersion: error.externalVersion,
            baseContent: this.persistedContent,
          });
          this.error = null;
          this.scheduleAutoMerge();
        } else {
          this.error = toError(error);
        }
        this.emit();
        throw error;
      }

      if (generation !== this.generation || target !== this.target) return;
      this.persistedRevision = Math.max(this.persistedRevision, saveRevision);
      this.persistedContent = saveContent;
      this.lineage.saved(saveContent, Date.now());
      this.rememberLineage();
      // Edits made during the save start a new wait of their own.
      this.unsavedSince = this.persistedRevision < this.revision ? Date.now() : null;
      this.autoSaveRetryAttempt = 0;
      this.savingRevision = null;
      this.savingContent = null;
      this.error = null;
      const activeConflict = this.getSnapshot().conflict;
      if (activeConflict?.externalContent === saveContent && this.content === saveContent) {
        // An observation that matched the in-flight local snapshot could not
        // be acknowledged until the commit settled. Its successful return now
        // proves both branches converged on the same durable revision.
        this.conflict = null;
        this.haltDrain = false;
      }
      this.recoveryJournal?.acknowledge({
        targetKey: target.key,
        generation,
        persistedRevision: this.persistedRevision,
      });
      this.acknowledgeRecoveredRecords();
      this.emit();
    }
  }

  private async awaitActiveDrain(): Promise<void> {
    const active = this.drainPromise;
    if (!active) return;
    try {
      await active;
    } catch {
      // A destructive cancellation still waits for the operation to settle,
      // but a failed obsolete write must not prevent the requested deletion.
    }
  }

  /**
   * Rehydrate a synchronous crash snapshot after the durable baseline has
   * been read. A matching baseline is safe to resume as dirty; a changed
   * baseline becomes an explicit conflict and is never auto-overwritten.
   */
  private restoreRecoverySnapshot(): 'none' | 'dirty' | 'conflict' {
    this.recoveredRecords = [];
    if (!this.target || !this.recoveryJournal) return 'none';
    const records = this.recoveryJournal.list(this.target.key);
    const recovered = records[0];
    if (!recovered) return 'none';

    // Interrupted recovery can leave the same branch under several owners.
    // Capture those exact records now so resolving it retires every copy, but
    // never a distinct draft or an owner's later edit.
    this.recoveredRecords = records.filter(
      (record) =>
        record.content === recovered.content &&
        record.persistedContent === recovered.persistedContent,
    );

    if (recovered.content === this.content) {
      this.acknowledgeRecoveredRecords();
      return 'none';
    }

    const externalContent = this.content;
    this.generation = Math.max(this.generation, recovered.generation) + 1;
    this.revision = Math.max(this.revision, recovered.revision) + 1;
    this.content = recovered.content;

    if (recovered.persistedContent === externalContent) {
      this.writeRecoverySnapshot();
      return 'dirty';
    }

    // Preserve the journal's prior baseline so a second crash continues to
    // reopen as a conflict until the user explicitly chooses a branch.
    this.persistedContent = recovered.persistedContent;
    this.haltDrain = true;
    this.conflict = {
      recoveredDraft: true,
      recoveredDraftCapturedAt: Math.min(
        ...this.recoveredRecords.map((record) => record.updatedAt),
      ),
      targetKey: this.target.key,
      localContent: recovered.content,
      localRevision: this.revision,
      externalContent,
      externalVersion: null,
      baseContent: recovered.persistedContent,
    };
    this.writeRecoverySnapshot();
    return 'conflict';
  }

  private writeRecoverySnapshot(): void {
    if (!this.target || !this.recoveryJournal) return;
    if (this.persistedRevision >= this.revision && (!this.conflict || this.holdingSavedText())) {
      return;
    }
    this.recoveryJournal.write({
      targetKey: this.target.key,
      generation: this.generation,
      revision: this.revision,
      content: this.content,
      persistedContent: this.persistedContent,
    });
  }

  private discardRecoverySnapshot(): void {
    if (!this.target) return;
    this.recoveryJournal?.discard(this.target.key);
    this.acknowledgeRecoveredRecords();
  }

  private acknowledgeRecoveredRecords(): void {
    for (const record of this.recoveredRecords) this.recoveryJournal?.acknowledgeRecord(record);
    this.recoveredRecords = [];
  }

  private detach(): void {
    this.clearAutoMergeTimer();
    this.clearAutoSaveTimer();
    this.autoSaveRetryAttempt = 0;
    this.generation += 1;
    this.externalSequence = -1;
    this.target = null;
    this.persistedContent = null;
    this.lineage.reset();
    this.localEditedAt = undefined;
    this.unsavedSince = null;
    this.savingRevision = null;
    this.savingContent = null;
    this.error = null;
    this.conflict = null;
    this.haltDrain = false;
    this.lifecycle = 'closed';
    this.frozen = true;
    this.emit();
  }

  private assertNotPreparingClose(): void {
    if (this.lifecycle === 'closing') {
      throw new Error('The document is already prepared for close.');
    }
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationTail.then(operation, operation);
    this.operationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private createSnapshot(): DocumentSessionSnapshot {
    return Object.freeze({
      targetKey: this.target?.key ?? null,
      content: this.content,
      revision: this.revision,
      persistedRevision: this.persistedRevision,
      persistedContent: this.persistedContent,
      savingRevision: this.savingRevision,
      generation: this.generation,
      status: this.computeStatus(),
      lifecycle: this.lifecycle,
      frozen: this.frozen,
      error: this.error,
      conflict: this.conflict,
    });
  }

  private computeStatus(): DocumentSessionStatus {
    if (this.lifecycle === 'closed') return 'closed';
    if (!this.target) return 'idle';
    if (this.conflict && !this.holdingSavedText()) return 'conflict';
    if (this.error) return 'error';
    if (this.savingRevision !== null) return 'saving';
    return this.persistedRevision < this.revision ? 'dirty' : 'saved';
  }

  /**
   * Whether the open conflict is only a newer version in storage being held
   * for a moment while everything here is saved: nothing is unsaved, nothing
   * needs a decision, and nothing would be lost if the app closed now.
   */
  private holdingSavedText(): boolean {
    return (
      this.conflict?.merging === true &&
      this.savingRevision === null &&
      this.persistedRevision >= this.revision &&
      this.conflict.localContent === this.persistedContent
    );
  }

  private emit(): void {
    // A wait for proof belongs to the conflict it was started for.
    if (!this.conflict) this.forkWait = null;
    this.snapshot = this.createSnapshot();
    for (const listener of [...this.listeners]) listener();
  }

  /** Begin remembering a newly opened document, from where a restart left it if known. */
  private openLineage(content: string | null): void {
    const key = this.target?.key;
    if (!key || content === null) {
      this.lineage.reset();
      return;
    }
    let record = null;
    try {
      record = this.lineageStore?.read(key) ?? null;
    } catch {
      record = null;
    }
    this.lineage.opened(content, Date.now(), record);
    this.rememberLineage();
  }

  /** Storage holds a version written by someone else, and the session goes on from it. */
  private tookOutside(content: string, origin?: DocumentExternalOrigin): void {
    this.lineage.tookOutside(content, origin?.modifiedAt ?? Date.now(), origin?.savedBy);
    this.rememberLineage();
  }

  /** Keep what this document was last built on where a restart can find it. */
  private rememberLineage(): void {
    const key = this.target?.key;
    if (!this.lineageStore || !key) return;
    try {
      this.lineageStore.write(key, this.lineage.record());
    } catch {
      // Best effort: the next session starts from the file.
    }
  }

  private forgetLineage(key: string): void {
    try {
      this.lineageStore?.write(key, null);
    } catch {
      // Nothing depends on this.
    }
  }

  private emitEvent(event: DocumentSessionEvent): void {
    for (const listener of [...this.eventListeners]) {
      try {
        listener(event);
      } catch {
        // A notice that fails to show must not disturb persistence.
      }
    }
  }

  /**
   * Mark a conflict the session can settle by itself: both versions are text
   * that started from a known baseline, they change different parts of it,
   * and the target can keep the local text in case the user wants it back.
   */
  private withMergePlan(conflict: DocumentSessionConflict): DocumentSessionConflict {
    const base = this.persistedContent;
    const external = conflict.externalContent;
    if (
      !this.autoMergeEnabled ||
      typeof this.target?.park !== 'function' ||
      conflict.recoveredDraft ||
      external === null ||
      typeof base !== 'string'
    ) {
      return withoutMergePlan(conflict);
    }
    const origin = versionOrigin(conflict.externalOrigin);
    const fork = this.forkMerge(conflict.localContent, external, origin);
    const merging =
      (fork !== null && (fork.proven || fork.waitMs > 0)) ||
      this.lineage.merge(base, conflict.localContent, external, origin).clean;
    return merging ? { ...conflict, merging: true } : withoutMergePlan(conflict);
  }

  /**
   * How `local` and `external`, the version storage now holds, combine from
   * the text the two parted at. Null when `external` was built on the saves
   * made here (the ordinary case: combine from the last save), when the two
   * do not combine cleanly from there, or when nothing of this session's
   * would be added.
   *
   * It may be used only once `proven`. A version that lacks the typing here
   * either never saw it or removed it on purpose, and only the sync service
   * setting a save from here aside says which.
   */
  private forkMerge(
    local: string,
    external: string | null,
    origin: DocumentVersionOrigin,
  ): ForkMerge | null {
    if (external === null || !this.autoMergeEnabled || typeof this.target?.park !== 'function') {
      return null;
    }
    const stamp = this.lineage.stamp;
    if (this.partingMemo?.external !== external || this.partingMemo.stamp !== stamp) {
      this.partingMemo = {
        external,
        stamp,
        parting: this.lineage.parting(external),
      };
    }
    const parting = this.partingMemo.parting;
    if (!parting) return null;
    const result = this.lineage.merge(parting.from, local, external, origin);
    if (!result.clean || result.merged === external) return null;
    const now = Date.now();
    // The wait for proof runs from when this version was first seen in storage.
    if (this.forkWait?.external !== external) this.forkWait = { external, since: now };
    const proven = parting.provenUntil !== null && now <= parting.provenUntil;
    return {
      merged: result.merged,
      proven,
      waitMs: proven ? 0 : Math.max(0, this.concurrentSaveGraceMs - (now - this.forkWait.since)),
    };
  }

  /**
   * Whether a version in storage should wait rather than replace clean text
   * here: it parts from the saves made here, and proof that it was written at
   * the same time is in hand or still worth a moment's wait.
   */
  private holdsFor(external: string, origin?: DocumentExternalOrigin): boolean {
    const fork = this.forkMerge(this.content, external, versionOrigin(origin));
    return fork !== null && (fork.proven || fork.waitMs > 0);
  }

  private clearAutoMergeTimer(): void {
    if (this.autoMergeTimer === null) return;
    clearTimeout(this.autoMergeTimer);
    this.autoMergeTimer = null;
  }

  /** Apply a planned merge once typing has paused: applying it remounts the editor. */
  private scheduleAutoMerge(atLeastMs = 0): void {
    this.clearAutoMergeTimer();
    if (!this.conflict?.merging) return;
    const idleFor = this.localEditedAt === undefined ? Infinity : Date.now() - this.localEditedAt;
    const delay = Math.max(atLeastMs, this.autoMergeIdleMs - idleFor);
    this.autoMergeTimer = setTimeout(() => {
      this.autoMergeTimer = null;
      void this.enqueueOperation(() => this.performAutoMerge()).catch(() => undefined);
    }, delay);
  }

  /**
   * Combine the local and outside versions and save the result. Every check is
   * repeated at the moment of applying: typing and newer outside changes can
   * both arrive while this waits.
   */
  private async performAutoMerge(final = false): Promise<void> {
    const target = this.target;
    if (!target || !this.conflict?.merging || this.lifecycle === 'closed') return;
    await this.awaitActiveDrain();
    const conflict = this.conflict;
    const base = this.persistedContent;
    if (
      !conflict?.merging ||
      this.target !== target ||
      !target.park ||
      conflict.externalContent === null ||
      typeof base !== 'string'
    ) {
      return;
    }
    const local = this.content;
    const external = conflict.externalContent;
    // When storage's version was not built on the saves made here, the right
    // starting text is where the two parted, but only once the sync service
    // has shown they were written at the same time. Until then it is worth a
    // short wait; after it, this is an ordinary newer version.
    const origin = versionOrigin(conflict.externalOrigin);
    const fork = this.forkMerge(local, external, origin);
    if (fork && !fork.proven && fork.waitMs > 0 && !final) {
      this.scheduleAutoMerge(fork.waitMs);
      return;
    }
    const fromFork = fork?.proven === true;
    const result = fromFork
      ? ({ clean: true, merged: fork.merged } as const)
      : this.lineage.merge(base, local, external, origin);
    const giveUp = () => {
      // Fall back to asking the user; never merge without the safety copy.
      if (this.conflict !== conflict) return;
      this.conflict = withoutMergePlan(conflict);
      this.emit();
    };
    if (!result.clean) {
      giveUp();
      return;
    }
    if (!fromFork && local === base) {
      // Nothing was typed here since the last save and nothing shows the two
      // were written at the same time: a newer version, taken as one.
      this.adoptExternalContent(external, conflict.externalOrigin);
      return;
    }
    const tookExternal = () => {
      this.persistedContent = external;
      if (fromFork) {
        // Combined with the saves made here, which the text still builds on.
        this.lineage.absorbed(external, conflict.externalOrigin?.modifiedAt ?? Date.now(), {
          setAside: false,
          by: conflict.externalOrigin?.savedBy,
          mine: local,
        });
        this.rememberLineage();
      } else {
        this.tookOutside(external, conflict.externalOrigin);
        // What the combining kept of the saves made here is still under the
        // text on screen: the last save, with the other version's changes.
        const kept = mergeText(local, result.merged, base);
        if (kept.clean && kept.merged !== external) {
          this.lineage.carried(kept.merged, Date.now());
          this.rememberLineage();
        }
      }
      this.conflict = null;
      this.error = null;
      this.haltDrain = false;
      this.autoSaveRetryAttempt = 0;
    };
    const save = async () => {
      if (this.lifecycle !== 'open' || this.frozen) return;
      try {
        await this.flush('conflict');
      } catch {
        // The session already records why: a still newer outside change is a new
        // conflict, and an ordinary write failure retries like any other save.
        if (!this.conflict && this.persistedRevision < this.revision) this.scheduleAutoSave();
      }
    };

    if (result.merged === local) {
      // The other version has nothing this text lacks, so nothing changes for
      // the user: no copy to keep, no editor to reload. Storage is behind,
      // and the text here is saved over it.
      this.revision += 1;
      tookExternal();
      this.writeRecoverySnapshot();
      this.emit();
      await save();
      return;
    }

    try {
      await target.park({
        targetKey: target.key,
        content: local,
        origin: 'premerge',
        currentContent: external,
      });
    } catch {
      giveUp();
      return;
    }
    if (this.conflict !== conflict || this.content !== local || this.target !== target) {
      // Something moved while the copy was written; plan again from the new state.
      this.scheduleAutoMerge();
      return;
    }

    this.content = result.merged;
    this.revision += 1;
    this.generation += 1;
    tookExternal();
    this.writeRecoverySnapshot();
    this.emit();
    this.emitEvent({
      type: 'merged',
      targetKey: target.key,
      localContent: local,
      externalContent: external,
      mergedContent: result.merged,
      ...(conflict.externalOrigin ? { externalOrigin: conflict.externalOrigin } : {}),
    });
    await save();
  }

  /**
   * Before leaving a document whose conflict is open: finish a planned merge,
   * or set the local text aside and take the saved file, so the user is never
   * trapped on a document. Without a target that can keep the text, the
   * conflict stays and the caller's flush reports it as before.
   */
  private async settleConflictBeforeLeaving(): Promise<void> {
    this.clearAutoMergeTimer();
    // No time left to wait for proof: decide with what is known now.
    if (this.conflict?.merging) await this.performAutoMerge(true);
    const conflict = this.conflict;
    const target = this.target;
    if (!conflict || !target?.park || conflict.externalContent === null) return;
    await this.awaitActiveDrain();
    if (this.conflict !== conflict || this.target !== target) return;
    const origin = conflict.recoveredDraft ? 'draft' : 'local';
    await target.park({
      targetKey: target.key,
      content: this.content,
      origin,
      currentContent: conflict.externalContent,
    });
    if (this.conflict !== conflict || this.target !== target) return;
    this.discardRecoverySnapshot();
    this.content = conflict.externalContent;
    this.persistedContent = conflict.externalContent;
    this.tookOutside(conflict.externalContent, conflict.externalOrigin);
    this.revision += 1;
    this.persistedRevision = this.revision;
    this.generation += 1;
    this.localEditedAt = undefined;
    this.unsavedSince = null;
    this.conflict = null;
    this.error = null;
    this.haltDrain = false;
    this.emit();
    this.emitEvent({ type: 'parked', targetKey: target.key, origin });
  }
}

/** The version storage holds, as the lineage wants it described. */
function versionOrigin(origin: DocumentExternalOrigin | undefined): DocumentVersionOrigin {
  return { at: origin?.modifiedAt ?? null, by: origin?.savedBy };
}

function withoutMergePlan(conflict: DocumentSessionConflict): DocumentSessionConflict {
  if (!('merging' in conflict)) return conflict;
  const next = { ...conflict };
  delete next.merging;
  return next;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function normalizeRetryDelays(delays: readonly number[]): readonly number[] {
  return delays.map((delay) => {
    if (!Number.isFinite(delay) || delay < 0) {
      throw new TypeError('Autosave retry delays must be finite, non-negative numbers.');
    }
    return Math.floor(delay);
  });
}
