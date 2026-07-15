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
import type { DocumentConflictDetailsMessage } from '@bendyline/docblocks/vscode';
import { toError } from './toError.js';

/** Save after twenty seconds without another accepted editor snapshot. */
export const DEFAULT_VSCODE_AUTO_SAVE_DELAY_MS = 20_000;

export interface HostDocumentSnapshot {
  content: string;
  version: number;
  /** Extension-host observation time, used only for conflict diagnostics. */
  observedAt?: number;
  /** Whether VS Code currently considers this document snapshot unsaved. */
  isDirty?: boolean | null;
}

interface ObservedHostDocumentSnapshot extends HostDocumentSnapshot {
  observedAt: number;
  isDirty: boolean | null;
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

/**
 * The subset of VS Code's built-in save participants whose effect on our own
 * write is exactly characterizable, resolved for the target document (so
 * language-specific overrides such as `"[markdown]"` are honored).
 *
 * Only transformations the user has actually enabled are forgiven; everything
 * else stays a conflict.
 */
export interface SaveParticipantPolicy {
  /** `files.trimTrailingWhitespace` */
  trimTrailingWhitespace: boolean;
}

/** Forgive nothing beyond VS Code's unconditional EOL/final-newline handling. */
export const STRICT_SAVE_PARTICIPANT_POLICY: SaveParticipantPolicy = Object.freeze({
  trimTrailingWhitespace: false,
});

export interface VscodeDocumentSyncOptions {
  autoSaveDelayMs?: number;
  autoSaveEnabled?: boolean;
  createSessionId?: () => string;
  now?: () => number;
  /**
   * Read at every commit rather than captured once, so toggling
   * `files.trimTrailingWhitespace` takes effect without reopening the editor.
   */
  readSaveParticipantPolicy?: () => SaveParticipantPolicy;
}

export interface VscodeDocumentSyncSnapshot {
  sessionId: string;
  baseDocumentVersion: number;
  documentVersion: number;
  acknowledgedClientRevision: number;
  session: DocumentSessionSnapshot;
  conflict: DocumentConflictDetailsMessage | null;
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
  private readonly now: () => number;
  private readonly listeners = new Set<SyncListener>();
  private readonly unsubscribeSession: () => void;

  private sessionId: string;
  private baseDocumentVersion: number;
  private documentVersion: number;
  private acknowledgedClientRevision = 0;
  private clientScope: DocumentSessionEditScope | null = null;
  private localEditedAt: number | null = null;
  private lastExternalSnapshot: ObservedHostDocumentSnapshot | null = null;

  private constructor(
    adapter: HostDocumentAdapter,
    initial: HostDocumentSnapshot,
    options: VscodeDocumentSyncOptions,
  ) {
    this.createSessionId = options.createSessionId ?? createSessionId;
    this.now = options.now ?? Date.now;
    this.sessionId = this.createSessionId();
    this.baseDocumentVersion = initial.version;
    this.documentVersion = initial.version;
    this.session = new DocumentSession({
      autoSaveDelayMs: options.autoSaveDelayMs ?? DEFAULT_VSCODE_AUTO_SAVE_DELAY_MS,
      autoSaveEnabled: options.autoSaveEnabled,
    });
    this.target = new VscodeCommitTarget(
      adapter,
      initial,
      (committed) => {
        this.documentVersion = committed.version;
        this.emit();
      },
      (observed) => {
        this.rememberExternalSnapshot(observed);
      },
      options.readSaveParticipantPolicy ?? (() => STRICT_SAVE_PARTICIPANT_POLICY),
    );
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
      conflict: this.createConflictDetails(),
    });
  }

  public setAutoSaveEnabled(enabled: boolean): void {
    this.session.setAutoSaveEnabled(enabled);
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
      const previousContent = this.session.getSnapshot().content;
      const sessionRevision = this.session.edit(edit.content, scope);
      if (edit.content !== previousContent) this.localEditedAt = this.now();
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

  /**
   * Persist through the latest accepted client revision or report failure.
   *
   * A save request only names the revision the user could see when they asked;
   * it is not a compare-and-swap. Edits reach this session through a separate,
   * faster ingress than save requests do (LatestDocumentEditQueue vs the
   * bounded message queue), so typing immediately after Ctrl+S routinely lands
   * a newer accepted revision before the save request is processed. Since every
   * edit is a complete snapshot on the same branch, flushing then persists a
   * superset of what the user asked to save — exactly this method's contract —
   * so a stale-but-lower request must flush rather than drop the save intent.
   *
   * A request *ahead* of the acknowledged revision is still a real failure:
   * the session does not hold that content and cannot persist it. Branch
   * identity (sessionId + baseDocumentVersion) is enforced by validateEnvelope,
   * so a lower revision here can only be this session's own older request.
   */
  public async save(save: WebviewSaveEnvelope): Promise<DocumentSessionSnapshot> {
    const invalid = this.validateEnvelope(save);
    if (invalid) throw new Error(invalid);
    if (save.clientRevision > this.acknowledgedClientRevision) {
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
    const observed = this.rememberExternalSnapshot(snapshot);
    const result = this.session.observeExternal({
      targetKey: this.target.key,
      content: observed.content,
      version: observed.version,
    });

    this.documentVersion = observed.version;
    if (result !== 'conflict') {
      this.target.rebase(observed);
    }

    if (result === 'applied') {
      this.rotateClientBranch(observed.version);
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
    const external = this.rememberExternalSnapshot(await this.target.read());
    const observationResult = this.session.observeExternal({
      targetKey: this.target.key,
      content: external.content,
      version: external.version,
    });
    this.target.rebase(external);
    this.documentVersion = external.version;

    // The branches may have converged while the conflict controls were open.
    // Acknowledge that byte-identical text instead of issuing a redundant
    // overwrite that can generate a second conflict notification.
    if (!this.session.getSnapshot().conflict) {
      if (observationResult === 'applied') this.rotateClientBranch(external.version);
      return this.session.getSnapshot();
    }

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
    this.localEditedAt = null;
    this.captureClientScope();
    this.emit();
  }

  private captureClientScope(): void {
    const snapshot = this.session.getSnapshot();
    this.clientScope = snapshot.targetKey
      ? { targetKey: snapshot.targetKey, generation: snapshot.generation }
      : null;
  }

  private rememberExternalSnapshot(snapshot: HostDocumentSnapshot): ObservedHostDocumentSnapshot {
    const observed: ObservedHostDocumentSnapshot = {
      ...snapshot,
      observedAt: snapshot.observedAt ?? this.now(),
      isDirty: snapshot.isDirty ?? null,
    };
    this.lastExternalSnapshot = observed;
    return observed;
  }

  private createConflictDetails(): DocumentConflictDetailsMessage | null {
    const conflict = this.session.getSnapshot().conflict;
    if (!conflict) return null;
    const observed = this.lastExternalSnapshot;
    const matchesObserved =
      observed !== null &&
      observed.version === conflict.externalVersion &&
      observed.content === conflict.externalContent;
    return Object.freeze({
      localBaseDocumentVersion: this.baseDocumentVersion,
      externalDocumentVersion:
        typeof conflict.externalVersion === 'number'
          ? conflict.externalVersion
          : this.documentVersion,
      localBytes: utf8ByteLength(conflict.localContent),
      externalBytes:
        conflict.externalContent === null ? null : utf8ByteLength(conflict.externalContent),
      localEditedAt: this.localEditedAt,
      externalObservedAt: matchesObserved ? observed.observedAt : null,
      externalIsDirty: matchesObserved ? observed.isDirty : null,
    });
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
    private readonly onExternalSnapshot: (snapshot: HostDocumentSnapshot) => void,
    private readonly readSaveParticipantPolicy: () => SaveParticipantPolicy,
  ) {
    this.key = adapter.key;
    this.baseline = initial;
  }

  public async commit(request: DocumentCommitRequest): Promise<{ version: number }> {
    const policy = this.readSaveParticipantPolicy();
    const actual = await this.adapter.read();
    if (actual.version !== this.baseline.version || actual.content !== this.baseline.content) {
      if (hasEquivalentSavedHostText(actual.content, request.content, policy)) {
        // VS Code already contains the complete local snapshot. This can
        // happen when an equivalent save/change notification wins the race,
        // including VS Code's line-ending and final-newline normalization.
        this.baseline = actual;
        if (actual.isDirty !== true) {
          this.onCommitted(actual);
          return { version: actual.version };
        }
      }
      if (hasEquivalentHostText(actual.content, this.baseline.content)) {
        // Version-only and host newline-normalization changes carry no
        // competing document text and are safe to absorb before applying the
        // pending DocBlocks revision.
        this.baseline = actual;
      } else {
        this.onExternalSnapshot(actual);
        throw new DocumentCommitConflictError(
          'The VS Code document changed before the DocBlocks revision could be committed.',
          actual.content,
          actual.version,
        );
      }
    }

    let committed: HostDocumentSnapshot;
    try {
      committed = await this.adapter.replaceAndSave(request.content, actual);
    } catch (error: unknown) {
      if (error instanceof HostDocumentChangedError) {
        this.onExternalSnapshot(error.actual);
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
      if (hasEquivalentSavedHostText(afterFailure.content, request.content, policy)) {
        this.baseline = afterFailure;
      }
      throw error;
    }

    if (!hasEquivalentSavedHostText(committed.content, request.content, policy)) {
      this.onExternalSnapshot(committed);
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

/**
 * Compare two independent host observations. Only VS Code's unconditional
 * line-ending and final-newline handling is absorbed; a save participant never
 * runs between two reads, so nothing else may be forgiven here.
 */
function hasEquivalentHostText(left: string, right: string): boolean {
  if (left === right) return true;
  return normalizeHostText(left) === normalizeHostText(right);
}

/**
 * Compare a host snapshot taken after `document.save()` against the text this
 * extension asked VS Code to write.
 *
 * `replaceAndSave` holds the applying-edit flag across both applyEdit and
 * save(), so VS Code's save participants rewrite our own bytes inside that
 * window and their document-change events are deliberately suppressed. This
 * comparison is therefore the only external-change detector for the window,
 * and it must not mistake a participant's rewrite of our write for a hostile
 * edit: `files.trimTrailingWhitespace` alone would otherwise fail every save
 * of a markdown document that uses trailing-double-space hard line breaks.
 *
 * We forgive exactly the transformations that VS Code is *configured* to
 * perform on this document, and nothing else. Any difference in a
 * non-whitespace character, or whitespace anywhere but the end of a line,
 * still raises a conflict, so a real concurrent edit is still caught.
 *
 * Known limits:
 * - With `files.trimTrailingWhitespace` enabled, a concurrent external edit
 *   that *only* adds or removes trailing whitespace is absorbed silently. In
 *   markdown that whitespace is semantic (hard line breaks), but VS Code is
 *   already configured to destroy it on save, so nothing is lost that the
 *   user's own setting would have kept.
 * - `editor.formatOnSave` with a real markdown formatter rewrites content
 *   arbitrarily. That is not characterizable, so it still surfaces as a
 *   conflict rather than silently adopting a formatter's output as if the
 *   user's draft had been persisted verbatim.
 */
function hasEquivalentSavedHostText(
  left: string,
  right: string,
  policy: SaveParticipantPolicy,
): boolean {
  if (left === right) return true;
  return normalizeSavedHostText(left, policy) === normalizeSavedHostText(right, policy);
}

function normalizeHostText(content: string): string {
  return content.replace(/\r\n?/gu, '\n').replace(/\n+$/u, '');
}

function normalizeSavedHostText(content: string, policy: SaveParticipantPolicy): string {
  const lineEndingsNormalized = content.replace(/\r\n?/gu, '\n');
  // Trim per line before collapsing the tail so a whitespace-only final line
  // reduces to nothing, exactly as trimTrailingWhitespace + trimFinalNewlines
  // would leave it.
  const trimmed = policy.trimTrailingWhitespace
    ? lineEndingsNormalized.replace(/[^\S\n]+$/gmu, '')
    : lineEndingsNormalized;
  return trimmed.replace(/\n+$/u, '');
}

let sessionSequence = 0;

function createSessionId(): string {
  sessionSequence += 1;
  return `${Date.now().toString(36)}-${sessionSequence.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
