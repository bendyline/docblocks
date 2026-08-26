import type {
  DocumentCommitTarget,
  DocumentConflictStrategy,
  DocumentExternalChangeResult,
  DocumentExternalSnapshot,
  DocumentSaveReason,
  DocumentSessionConflict,
  DocumentSessionEditScope,
  DocumentSessionLifecycle,
  DocumentSessionOptions,
  DocumentSessionSnapshot,
  DocumentSessionStatus,
  DocumentSessionTransition,
} from './types.js';
import { isFileSystemMoveStateError } from '../filesystem/move-error.js';
import type { DocumentRecoveryJournal } from './recovery-journal.js';

type SessionListener = () => void;

const DEFAULT_AUTO_SAVE_RETRY_DELAYS_MS = [1_000, 3_000, 10_000] as const;

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
 * - a target is never changed by a React effect cleanup.
 */
export class DocumentSession {
  private readonly autoSaveDelayMs: number;
  private readonly autoSaveRetryDelaysMs: readonly number[];
  private readonly recoveryJournal: DocumentRecoveryJournal | null;
  private readonly listeners = new Set<SessionListener>();
  private autoSaveEnabled: boolean;

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
    this.recoveryJournal = options.recoveryJournal ?? null;
    this.snapshot = this.createSnapshot();
  }

  public readonly subscribe = (listener: SessionListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  public readonly getSnapshot = (): DocumentSessionSnapshot => this.snapshot;

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
    this.error = null;
    this.autoSaveRetryAttempt = 0;
    if (this.conflict) {
      this.conflict = {
        ...this.conflict,
        localContent: content,
        localRevision: this.revision,
      };
    }
    this.writeRecoverySnapshot();
    if (!this.conflict) this.scheduleAutoSave();
    this.emit();
    return this.revision;
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
        await moveStorage();
        this.generation += 1;
        this.externalSequence = -1;
        this.target = nextTarget;
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
      if (localBranchIsStillClean && change.content !== null) {
        this.adoptExternalContent(change.content);
        return 'applied';
      }

      this.clearAutoSaveTimer();
      this.haltDrain = true;
      this.conflict = {
        targetKey: change.targetKey,
        localContent: this.content,
        localRevision: this.revision,
        externalContent: change.content,
        externalVersion,
      };
      this.error = null;
      this.writeRecoverySnapshot();
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

    if (isClean && change.content !== null) {
      this.adoptExternalContent(change.content);
      return 'applied';
    }

    this.clearAutoSaveTimer();
    this.haltDrain = true;
    this.conflict = {
      targetKey: change.targetKey,
      localContent: this.content,
      localRevision: this.revision,
      externalContent: change.content,
      externalVersion: change.version ?? null,
    };
    this.error = null;
    this.writeRecoverySnapshot();
    this.emit();
    return 'conflict';
  }

  private adoptExternalContent(content: string): void {
    this.clearAutoSaveTimer();
    this.autoSaveRetryAttempt = 0;
    this.content = content;
    this.revision += 1;
    this.persistedRevision = this.revision;
    this.persistedContent = content;
    this.generation += 1;
    this.haltDrain = false;
    this.error = null;
    this.conflict = null;
    this.discardRecoverySnapshot();
    this.emit();
  }

  public resolveConflict(strategy: DocumentConflictStrategy): Promise<DocumentSessionSnapshot> {
    return this.enqueueOperation(async () => {
      if (!this.conflict) return this.snapshot;

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
          this.persistedRevision = this.revision;
          this.lifecycle = 'open';
          this.frozen = false;
        }
        this.emit();
        return this.snapshot;
      }

      // Keep the local branch, but make the observed external snapshot the
      // optimistic baseline for the next conditional commit.
      this.persistedContent = currentConflict.externalContent;
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
      this.haltDrain = false;
      this.emit();
      try {
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
      this.revision += 1;
      this.persistedRevision = this.revision;
      this.persistedContent = next.target ? next.content : null;
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

  private scheduleAutoSave(delayMs = this.autoSaveDelayMs): void {
    this.clearAutoSaveTimer();
    if (!this.autoSaveEnabled) return;
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
          this.conflict = {
            targetKey: target.key,
            localContent: this.content,
            localRevision: this.revision,
            externalContent: error.externalContent,
            externalVersion: error.externalVersion,
          };
          this.error = null;
        } else {
          this.error = toError(error);
        }
        this.emit();
        throw error;
      }

      if (generation !== this.generation || target !== this.target) return;
      this.persistedRevision = Math.max(this.persistedRevision, saveRevision);
      this.persistedContent = saveContent;
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
    if (!this.target || !this.recoveryJournal) return 'none';
    const recovered = this.recoveryJournal.lookup(this.target.key);
    if (!recovered) return 'none';

    if (recovered.content === this.content) {
      this.recoveryJournal.acknowledge({
        targetKey: recovered.targetKey,
        generation: recovered.generation,
        persistedRevision: recovered.revision,
      });
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
      targetKey: this.target.key,
      localContent: recovered.content,
      localRevision: this.revision,
      externalContent,
      externalVersion: null,
    };
    this.writeRecoverySnapshot();
    return 'conflict';
  }

  private writeRecoverySnapshot(): void {
    if (!this.target || !this.recoveryJournal) return;
    if (this.persistedRevision >= this.revision && !this.conflict) return;
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
  }

  private detach(): void {
    this.clearAutoSaveTimer();
    this.autoSaveRetryAttempt = 0;
    this.generation += 1;
    this.externalSequence = -1;
    this.target = null;
    this.persistedContent = null;
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
    if (this.conflict) return 'conflict';
    if (this.error) return 'error';
    if (this.savingRevision !== null) return 'saving';
    return this.persistedRevision < this.revision ? 'dirty' : 'saved';
  }

  private emit(): void {
    this.snapshot = this.createSnapshot();
    for (const listener of [...this.listeners]) listener();
  }
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
