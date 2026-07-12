import {
  DocumentCommitConflictError,
  DocumentSession,
  type DocumentCommitRequest,
  type DocumentCommitTarget,
  type DocumentConflictStrategy,
  type DocumentExternalChangeResult,
  type DocumentSessionEditScope,
  type DocumentSessionSnapshot,
} from '@bendyline/docblocks/document';

export interface HostDocumentSnapshot {
  content: string;
  version: number;
}

/**
 * VS Code-specific storage operations. The adapter implementation owns the
 * WorkspaceEdit/TextDocument.save details; VscodeDocumentSync owns ordering,
 * revisions, optimistic baselines, and lifecycle.
 */
export interface HostDocumentAdapter {
  readonly key: string;
  read(): Promise<HostDocumentSnapshot>;
  /**
   * Recheck `expected` immediately before applying the replacement and reject
   * with HostDocumentChangedError if the host document no longer matches.
   */
  replaceAndSave(content: string, expected: HostDocumentSnapshot): Promise<HostDocumentSnapshot>;
}

/** Adapter-level optimistic precondition failure with the observed branch. */
export class HostDocumentChangedError extends Error {
  public readonly actual: HostDocumentSnapshot;

  public constructor(actual: HostDocumentSnapshot, message = 'The host document changed') {
    super(message);
    this.name = 'HostDocumentChangedError';
    this.actual = actual;
  }
}

export interface VscodeDocumentSyncOptions {
  autoSaveDelayMs?: number;
  createSessionId?: () => string;
}

export interface VscodeDocumentSyncSnapshot {
  sessionId: string;
  baseDocumentVersion: number;
  documentVersion: number;
  acknowledgedClientRevision: number;
  session: DocumentSessionSnapshot;
}

export interface WebviewEditEnvelope {
  sessionId: string;
  clientRevision: number;
  baseDocumentVersion: number;
  content: string;
}

export interface WebviewSaveEnvelope {
  sessionId: string;
  clientRevision: number;
  baseDocumentVersion: number;
}

export interface EditAcceptance {
  accepted: boolean;
  clientRevision: number;
  sessionRevision: number;
  message: string | null;
}

type SyncListener = () => void;

/**
 * Host-owned synchronization boundary for one VS Code document panel.
 *
 * Webview edits are accepted immediately into a DocumentSession. The session
 * coalesces them for ~300ms and invokes exactly one commit target at a time.
 * The client branch is identified by sessionId + baseDocumentVersion, so a
 * queued edit from an older external baseline cannot be replayed later.
 */
export class VscodeDocumentSync {
  private readonly session: DocumentSession;
  private readonly target: VscodeCommitTarget;
  private readonly createSessionId: () => string;
  private readonly listeners = new Set<SyncListener>();
  private readonly unsubscribeSession: () => void;

  private sessionId: string;
  private baseDocumentVersion: number;
  private documentVersion: number;
  private acknowledgedClientRevision = 0;
  private clientScope: DocumentSessionEditScope | null = null;

  private constructor(
    adapter: HostDocumentAdapter,
    initial: HostDocumentSnapshot,
    options: VscodeDocumentSyncOptions,
  ) {
    this.createSessionId = options.createSessionId ?? createSessionId;
    this.sessionId = this.createSessionId();
    this.baseDocumentVersion = initial.version;
    this.documentVersion = initial.version;
    this.session = new DocumentSession({ autoSaveDelayMs: options.autoSaveDelayMs ?? 300 });
    this.target = new VscodeCommitTarget(adapter, initial, (committed) => {
      this.documentVersion = committed.version;
      this.emit();
    });
    this.unsubscribeSession = this.session.subscribe(() => this.emit());
  }

  public static async create(
    adapter: HostDocumentAdapter,
    options: VscodeDocumentSyncOptions = {},
  ): Promise<VscodeDocumentSync> {
    const initial = await adapter.read();
    const sync = new VscodeDocumentSync(adapter, initial, options);
    await sync.session.transitionTo(sync.target, initial.content);
    sync.captureClientScope();
    return sync;
  }

  public readonly subscribe = (listener: SyncListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  public getSnapshot(): VscodeDocumentSyncSnapshot {
    return Object.freeze({
      sessionId: this.sessionId,
      baseDocumentVersion: this.baseDocumentVersion,
      documentVersion: this.documentVersion,
      acknowledgedClientRevision: this.acknowledgedClientRevision,
      session: this.session.getSnapshot(),
    });
  }

  /** Accept a monotonic, possibly coalesced complete snapshot without waiting for disk I/O. */
  public acceptEdit(edit: WebviewEditEnvelope): EditAcceptance {
    const invalid = this.validateEnvelope(edit);
    if (invalid) return this.rejectEdit(edit.clientRevision, invalid);

    if (edit.clientRevision <= this.acknowledgedClientRevision) {
      return {
        accepted: true,
        clientRevision: edit.clientRevision,
        sessionRevision: this.session.getSnapshot().revision,
        message: null,
      };
    }

    try {
      const scope = this.clientScope;
      if (!scope) throw new Error('The VS Code document session has not finished opening.');
      const sessionRevision = this.session.edit(edit.content, scope);
      // Every edit is a complete snapshot. The webview ingress may coalesce
      // superseded messages while the host is delayed, so acknowledging a
      // monotonic jump is lossless and keeps the bounded queue honest.
      this.acknowledgedClientRevision = edit.clientRevision;
      this.emit();
      return {
        accepted: true,
        clientRevision: edit.clientRevision,
        sessionRevision,
        message: null,
      };
    } catch (error: unknown) {
      return this.rejectEdit(edit.clientRevision, toError(error).message);
    }
  }

  /** Persist through the latest accepted client revision or report failure. */
  public async save(save: WebviewSaveEnvelope): Promise<DocumentSessionSnapshot> {
    const invalid = this.validateEnvelope(save);
    if (invalid) throw new Error(invalid);
    if (save.clientRevision !== this.acknowledgedClientRevision) {
      throw new Error(
        `Cannot save client revision ${save.clientRevision}; revision ${this.acknowledgedClientRevision} is acknowledged.`,
      );
    }
    return this.session.flush('manual');
  }

  /**
   * Observe a TextDocument change not produced by this commit target. A clean
   * session rebases to it. A dirty/saving session enters conflict and retains
   * local content.
   */
  public observeExternal(snapshot: HostDocumentSnapshot): DocumentExternalChangeResult {
    const result = this.session.observeExternal({
      targetKey: this.target.key,
      content: snapshot.content,
      version: snapshot.version,
    });

    this.documentVersion = snapshot.version;
    if (result !== 'conflict') {
      this.target.rebase(snapshot);
    }

    if (result === 'applied') {
      this.rotateClientBranch(snapshot.version);
    } else {
      this.emit();
    }
    return result;
  }

  /** Resolve a surfaced conflict only after an explicit user choice. */
  public async resolveConflict(
    strategy: DocumentConflictStrategy,
  ): Promise<DocumentSessionSnapshot> {
    const conflict = this.session.getSnapshot().conflict;
    if (!conflict) return this.session.getSnapshot();

    // Re-read at resolution time: multiple external edits may have arrived
    // while the conflict UI was open, and the choice must apply to the latest
    // TextDocument rather than the first conflicting snapshot.
    const external = await this.target.read();
    this.target.rebase(external);
    this.documentVersion = external.version;

    let result = await this.session.resolveConflict(strategy);
    if (strategy === 'use-external') {
      if (result.content !== external.content) {
        result = await this.session.transitionTo(this.target, external.content);
      }
      this.rotateClientBranch(external.version);
    } else {
      this.emit();
    }
    return result;
  }

  /** Freeze the session and await all accepted edits before panel teardown. */
  public prepareClose(): Promise<DocumentSessionSnapshot> {
    return this.session.prepareClose();
  }

  public dispose(): void {
    // Normal callers prepareClose first. This also clears a pending autosave
    // timer for failed initialization/tests without allowing a detached
    // coordinator to write later.
    void this.session.cancel();
    this.unsubscribeSession();
    this.listeners.clear();
  }

  private validateEnvelope(envelope: {
    sessionId: string;
    clientRevision: number;
    baseDocumentVersion: number;
  }): string | null {
    if (envelope.sessionId !== this.sessionId) {
      return 'This edit belongs to an obsolete document session.';
    }
    if (envelope.baseDocumentVersion !== this.baseDocumentVersion) {
      return `This edit is based on document version ${envelope.baseDocumentVersion}, not ${this.baseDocumentVersion}.`;
    }
    return null;
  }

  private rejectEdit(clientRevision: number, message: string): EditAcceptance {
    return {
      accepted: false,
      clientRevision,
      sessionRevision: this.session.getSnapshot().revision,
      message,
    };
  }

  private rotateClientBranch(baseDocumentVersion: number): void {
    this.sessionId = this.createSessionId();
    this.baseDocumentVersion = baseDocumentVersion;
    this.acknowledgedClientRevision = 0;
    this.captureClientScope();
    this.emit();
  }

  private captureClientScope(): void {
    const snapshot = this.session.getSnapshot();
    this.clientScope = snapshot.targetKey
      ? { targetKey: snapshot.targetKey, generation: snapshot.generation }
      : null;
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/** Ensure an event guard always resets, including rejected WorkspaceEdits. */
export async function withApplyingEditFlag(
  setApplyingEdit: (isApplying: boolean) => void,
  applyEdit: () => Promise<void>,
): Promise<void> {
  setApplyingEdit(true);
  try {
    await applyEdit();
  } finally {
    setApplyingEdit(false);
  }
}

class VscodeCommitTarget implements DocumentCommitTarget {
  public readonly key: string;
  private baseline: HostDocumentSnapshot;

  public constructor(
    private readonly adapter: HostDocumentAdapter,
    initial: HostDocumentSnapshot,
    private readonly onCommitted: (snapshot: HostDocumentSnapshot) => void,
  ) {
    this.key = adapter.key;
    this.baseline = initial;
  }

  public async commit(request: DocumentCommitRequest): Promise<{ version: number }> {
    const actual = await this.adapter.read();
    if (actual.version !== this.baseline.version || actual.content !== this.baseline.content) {
      throw new DocumentCommitConflictError(
        'The VS Code document changed before the DocBlocks revision could be committed.',
        actual.content,
        actual.version,
      );
    }

    let committed: HostDocumentSnapshot;
    try {
      committed = await this.adapter.replaceAndSave(request.content, actual);
    } catch (error: unknown) {
      if (error instanceof HostDocumentChangedError) {
        throw new DocumentCommitConflictError(
          error.message,
          error.actual.content,
          error.actual.version,
        );
      }
      // WorkspaceEdit may have succeeded even when TextDocument.save failed.
      // Rebase that host-owned partial application so an honest retry saves it
      // instead of misclassifying it as an external conflict.
      const afterFailure = await this.adapter.read();
      if (afterFailure.content === request.content) this.baseline = afterFailure;
      throw error;
    }

    if (committed.content !== request.content) {
      throw new DocumentCommitConflictError(
        'The VS Code document was changed while the DocBlocks revision was being saved.',
        committed.content,
        committed.version,
      );
    }
    this.baseline = committed;
    this.onCommitted(committed);
    return { version: committed.version };
  }

  public read(): Promise<HostDocumentSnapshot> {
    return this.adapter.read();
  }

  public rebase(snapshot: HostDocumentSnapshot): void {
    this.baseline = snapshot;
  }
}

let sessionSequence = 0;

function createSessionId(): string {
  sessionSequence += 1;
  return `${Date.now().toString(36)}-${sessionSequence.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
