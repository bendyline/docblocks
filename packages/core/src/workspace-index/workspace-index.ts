/**
 * In-memory workspace index: one shared listing of the files people can open,
 * plus each document's title, outline, and searchable text.
 *
 * Every feature that used to walk the workspace on its own (link picker,
 * quick-open, search) reads from here instead, so the workspace is walked once
 * and kept current from provider change events (or explicit refreshes where
 * the provider cannot watch).
 *
 * All provider calls go through one serial work loop, so at most one is ever
 * outstanding: on desktop every read queues behind the same per-workspace
 * lock as the user's saves, and parallel reads would only make saves wait.
 */

import { FsError } from '../filesystem/fs-error.js';
import type {
  FileSystemEntrySnapshot,
  FileSystemVersion,
  FileSystemWatchEvent,
  FileSystemWatchSubscription,
} from '../filesystem/v2.js';
import {
  isCompanionDirectoryName,
  isDiscoverableWorkspaceEntry,
  isMarkdownFileName,
} from '../filesystem/workspace-entry-rules.js';
import {
  WORKSPACE_ROOT,
  parseWorkspacePath,
  tryParseWorkspacePath,
  workspacePathContains,
  type WorkspacePath,
} from '../filesystem/workspace-path.js';
import {
  chooseOutsideInMarkdownPath,
  resolveOutsideInLayout,
  type OutsideInLayout,
} from '../workspace-settings/outside-in-layout.js';
import {
  analyzeDocumentBytes,
  nameOnlyDocument,
  type AnalyzedDocument,
  type DocumentIdentity,
} from './analyze.js';
import { createCheckpoint, searchDocuments, type SearchableDocument } from './search.js';
import {
  WORKSPACE_INDEX_LIMITS,
  type IndexedDocument,
  type WorkspaceIndex,
  type WorkspaceIndexFile,
  type WorkspaceIndexFileKind,
  type WorkspaceIndexLimits,
  type WorkspaceIndexOptions,
  type WorkspaceIndexSource,
  type WorkspaceIndexStatus,
  type WorkspaceIndexTruncation,
  type WorkspaceSearchLimits,
  type WorkspaceSearchQuery,
  type WorkspaceSearchResult,
} from './types.js';

interface IndexedFile extends WorkspaceIndexFile {
  readonly version: FileSystemVersion;
}

interface DocumentState {
  readonly identity: DocumentIdentity;
  /** Version of the Markdown source when listed; null when there is none. */
  readonly sourceVersion: FileSystemVersion | null;
  readonly sourceSize: number;
  readonly layout: OutsideInLayout | null;
  /** Null while queued for analysis. */
  analysis: AnalyzedDocument | null;
  /** Source version the analysis was built from. */
  analysisVersion: FileSystemVersion | null;
}

interface TreeState {
  readonly files: Map<WorkspacePath, IndexedFile>;
  readonly documents: Map<WorkspacePath, DocumentState>;
  readonly directories: Set<WorkspacePath>;
  readonly unreadable: Set<WorkspacePath>;
}

interface Truncation {
  readonly reason: WorkspaceIndexTruncation;
  readonly limit: number;
}

function emptyTree(): TreeState {
  return { files: new Map(), documents: new Map(), directories: new Set(), unreadable: new Set() };
}

/** Thrown inside the work loop once the index is disposed. */
class IndexStopped extends Error {}

class RootListingError extends Error {}

function fsCode(error: unknown): string | null {
  return error instanceof FsError ? error.code : null;
}

function isVanished(error: unknown): boolean {
  const code = fsCode(error);
  return code === 'not-found' || code === 'type-mismatch';
}

function classify(entry: FileSystemEntrySnapshot): WorkspaceIndexFileKind {
  if (isMarkdownFileName(entry.name)) return 'markdown';
  return resolveOutsideInLayout(entry.path) ? 'outside-in' : 'other';
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function defaultYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

const PUBLISH_INTERVAL_MS = 250;
const SLICE_MS = 8;

class WorkspaceIndexImpl implements WorkspaceIndex {
  public readonly workspaceId: string;

  private readonly source: WorkspaceIndexSource;
  private readonly limits: WorkspaceIndexLimits;
  private readonly yieldControl: () => Promise<void>;
  private readonly now: () => number;
  private readonly minRefreshIntervalMs: number;
  private readonly changeCoalesceMs: number;
  private readonly abort = new AbortController();

  private tree: TreeState = emptyTree();
  private truncation: Truncation | null = null;
  private analysisTruncation: Truncation | null = null;
  private rootError: string | null = null;
  private listedOnce = false;
  private analyzedCount = 0;
  private textCharacters = 0;
  private readIssues = 0;

  private started = false;
  private disposed = false;
  private paused = false;
  private pumping = false;
  private walkRequested = false;
  private lastWalkEnd: number | null = null;
  private readonly pendingChanges = new Set<WorkspacePath>();
  private changesReady = false;
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  private priority: WorkspacePath[] = [];
  private queue: DocumentState[] = [];
  private queueIndex = 0;
  private queueDirty = true;
  private sliceStart = 0;

  private subscription: FileSystemWatchSubscription | null = null;
  private watching = false;

  private readonly listeners = new Set<() => void>();
  private readonly listedWaiters = new Set<(listed: boolean) => void>();
  private generation = 0;
  private lastPublish = 0;
  private filesCache: readonly WorkspaceIndexFile[] | null = null;
  private documentsCache: readonly IndexedDocument[] | null = null;
  private statusCache: WorkspaceIndexStatus | null = null;

  public constructor(options: WorkspaceIndexOptions) {
    this.workspaceId = options.workspaceId;
    this.source = options.source;
    this.limits = { ...WORKSPACE_INDEX_LIMITS, ...options.limits };
    this.yieldControl = options.yieldControl ?? defaultYield;
    this.now = options.now ?? defaultNow;
    this.minRefreshIntervalMs = options.minRefreshIntervalMs ?? 15_000;
    this.changeCoalesceMs = options.changeCoalesceMs ?? 50;
  }

  // ── Public API ────────────────────────────────────────────────────────

  public getStatus(): WorkspaceIndexStatus {
    if (this.statusCache) return this.statusCache;
    let pendingCount = 0;
    for (const state of this.tree.documents.values()) {
      if (state.analysis === null) pendingCount += 1;
    }
    const phase = this.disposed
      ? 'disposed'
      : !this.started
        ? 'idle'
        : this.rootError !== null
          ? 'error'
          : !this.listedOnce
            ? 'listing'
            : pendingCount > 0
              ? 'analyzing'
              : 'ready';
    this.statusCache = Object.freeze({
      phase,
      fileCount: this.tree.files.size,
      documentCount: this.tree.documents.size,
      analyzedCount: this.analyzedCount,
      pendingCount,
      watching: this.watching,
      listed: this.listedOnce,
      truncated: this.truncation ?? this.analysisTruncation,
      issues: this.tree.unreadable.size + this.readIssues,
      error: this.rootError,
      generation: this.generation,
    });
    return this.statusCache;
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.startWatching();
    this.requestWalk(true);
  }

  public getFiles(): readonly WorkspaceIndexFile[] {
    if (!this.filesCache) {
      this.filesCache = Object.freeze(
        [...this.tree.files.values()]
          .map(({ version: _version, ...file }) => Object.freeze(file))
          .sort((left, right) => compareCodeUnits(left.path, right.path)),
      );
    }
    return this.filesCache;
  }

  public getDocuments(): readonly IndexedDocument[] {
    if (!this.documentsCache) {
      this.documentsCache = Object.freeze(
        [...this.tree.documents.values()]
          .map((state) => this.recordOf(state))
          .sort((left, right) => compareCodeUnits(left.path, right.path)),
      );
    }
    return this.documentsCache;
  }

  public getDocument(path: string): IndexedDocument | null {
    const canonical = tryParseWorkspacePath(path);
    const state = canonical === null ? undefined : this.tree.documents.get(canonical);
    return state ? this.recordOf(state) : null;
  }

  public has(path: string): 'present' | 'absent' | 'unknown' {
    const canonical = tryParseWorkspacePath(path);
    if (canonical === null) return 'unknown';
    if (this.tree.files.has(canonical) || this.tree.directories.has(canonical)) return 'present';
    if (!this.listedOnce || this.truncation !== null || this.rootError !== null) return 'unknown';
    const segments = canonical.split('/');
    for (let index = 0; index < segments.length; index += 1) {
      const kind = index < segments.length - 1 ? 'directory' : 'file';
      if (!isDiscoverableWorkspaceEntry(segments[index]!, kind)) return 'unknown';
    }
    for (const directory of this.tree.unreadable) {
      if (workspacePathContains(directory, canonical)) return 'unknown';
    }
    return 'absent';
  }

  public whenListed(
    options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
  ): Promise<boolean> {
    if (this.listedOnce) return Promise.resolve(true);
    if (this.disposed) return Promise.resolve(false);
    const { signal, timeoutMs } = options;
    signal?.throwIfAborted();
    return new Promise<boolean>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        this.listedWaiters.delete(waiter);
        if (timer !== null) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const waiter = (listed: boolean) => {
        cleanup();
        resolve(listed);
      };
      const onAbort = () => {
        cleanup();
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      this.listedWaiters.add(waiter);
      if (timeoutMs !== undefined) timer = setTimeout(() => waiter(false), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  public search(
    query: WorkspaceSearchQuery,
    options: {
      readonly signal?: AbortSignal;
      readonly limits?: Partial<WorkspaceSearchLimits>;
    } = {},
  ): Promise<WorkspaceSearchResult> {
    const documents: SearchableDocument[] = [...this.tree.documents.values()].map((state) => ({
      record: this.recordOf(state),
      text: state.analysis?.text ?? null,
      pending: state.analysis === null,
    }));
    documents.sort((left, right) => compareCodeUnits(left.record.path, right.record.path));
    return searchDocuments(
      documents,
      query,
      createCheckpoint(this.yieldControl, this.now, options.signal, SLICE_MS),
      options.limits,
    );
  }

  public refresh(options: { readonly force?: boolean } = {}): void {
    if (!options.force && this.watching) return;
    this.requestWalk(options.force ?? false);
  }

  public invalidate(path: string): void {
    const canonical = tryParseWorkspacePath(path);
    if (canonical === null || !this.started || this.disposed) return;
    this.enqueueChange(canonical);
  }

  public prioritize(paths: readonly string[]): void {
    const canonical = paths
      .map((path) => tryParseWorkspacePath(path))
      .filter((path): path is WorkspacePath => path !== null);
    if (canonical.length === 0) return;
    this.priority = [...canonical, ...this.priority.filter((path) => !canonical.includes(path))];
    void this.pump();
  }

  public setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (!paused) void this.pump();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    if (this.changeTimer !== null) clearTimeout(this.changeTimer);
    this.changeTimer = null;
    const subscription = this.subscription;
    this.subscription = null;
    this.watching = false;
    if (subscription) void subscription.dispose().catch(() => undefined);
    for (const waiter of [...this.listedWaiters]) waiter(false);
    this.publish();
    this.listeners.clear();
  }

  // ── Scheduling ────────────────────────────────────────────────────────

  private requestWalk(force: boolean): void {
    if (!this.started || this.disposed) return;
    if (
      !force &&
      this.lastWalkEnd !== null &&
      this.now() - this.lastWalkEnd < this.minRefreshIntervalMs
    ) {
      return;
    }
    this.walkRequested = true;
    void this.pump();
  }

  private enqueueChange(path: WorkspacePath): void {
    this.pendingChanges.add(path);
    if (this.changeTimer !== null) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      this.changesReady = true;
      void this.pump();
    }, this.changeCoalesceMs);
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.disposed || !this.started) return;
    this.pumping = true;
    this.sliceStart = this.now();
    try {
      while (!this.disposed && !this.paused) {
        if (this.walkRequested) {
          this.walkRequested = false;
          await this.fullWalk();
          continue;
        }
        if (this.changesReady && this.pendingChanges.size > 0) {
          this.changesReady = false;
          const paths = [...this.pendingChanges];
          this.pendingChanges.clear();
          await this.applyChanges(paths);
          continue;
        }
        const next = this.nextPendingDocument();
        if (!next) break;
        await this.analyze(next);
        this.maybePublish();
      }
    } catch (error: unknown) {
      if (!(error instanceof IndexStopped)) {
        this.rootError = error instanceof Error ? error.message : 'Indexing failed.';
      }
    } finally {
      this.pumping = false;
      if (!this.disposed) this.publish();
    }
  }

  /** Yield to the host between slices; stop once disposed. */
  private async checkpoint(): Promise<void> {
    if (this.disposed) throw new IndexStopped();
    if (this.now() - this.sliceStart < SLICE_MS) return;
    await this.yieldControl();
    if (this.disposed) throw new IndexStopped();
    this.sliceStart = this.now();
  }

  // ── Watching ──────────────────────────────────────────────────────────

  private startWatching(): void {
    if (!this.source.watch || !this.source.capabilities?.watch) return;
    let subscription: FileSystemWatchSubscription;
    try {
      subscription = this.source.watch((event) => this.onWatchEvent(event), {
        onError: () => this.onWatchFailure(),
      });
    } catch {
      return;
    }
    this.subscription = subscription;
    this.watching = true;
    // Events start only at readiness; one reconciling walk covers the gap.
    subscription.ready.then(
      () => {
        if (this.subscription === subscription) this.requestWalk(true);
      },
      () => this.onWatchFailure(),
    );
  }

  private onWatchEvent(event: FileSystemWatchEvent): void {
    if (this.disposed) return;
    if (event.type === 'overflow') {
      this.requestWalk(true);
      return;
    }
    this.enqueueChange(event.path);
    if (event.type === 'moved' && event.destinationPath !== null) {
      this.enqueueChange(event.destinationPath);
    }
  }

  /** Fall back to explicit refreshes; never resubscribe automatically. */
  private onWatchFailure(): void {
    if (this.disposed || !this.watching) return;
    const subscription = this.subscription;
    this.subscription = null;
    this.watching = false;
    if (subscription) void subscription.dispose().catch(() => undefined);
    this.requestWalk(true);
    this.publish();
  }

  // ── Listing ───────────────────────────────────────────────────────────

  private async fullWalk(): Promise<void> {
    // The first listing publishes as it goes so quick-open has names early;
    // later walks build aside and swap, so nothing flickers out meanwhile.
    const progressive = !this.listedOnce;
    const previous = this.tree.documents;
    const target = emptyTree();
    if (progressive) this.tree = target;
    let truncation: Truncation | null;
    try {
      truncation = await this.listTree(target, previous, WORKSPACE_ROOT, 0, progressive);
    } catch (error: unknown) {
      if (!(error instanceof RootListingError)) throw error;
      this.rootError = error.message;
      this.lastWalkEnd = this.now();
      for (const waiter of [...this.listedWaiters]) waiter(false);
      return;
    }
    this.tree = target;
    this.truncation = truncation;
    this.rootError = null;
    this.lastWalkEnd = this.now();
    this.afterStructuralChange();
    if (!this.listedOnce) {
      this.listedOnce = true;
      for (const waiter of [...this.listedWaiters]) waiter(true);
    }
    this.publish();
  }

  /**
   * Breadth-first listing of `root` into `target`, carrying analysis over
   * from `previous` for documents whose source version is unchanged.
   */
  private async listTree(
    target: TreeState,
    previous: ReadonlyMap<WorkspacePath, DocumentState>,
    root: WorkspacePath,
    rootDepth: number,
    progressive: boolean,
  ): Promise<Truncation | null> {
    let truncation: Truncation | null = null;
    const queue: { readonly path: WorkspacePath; readonly depth: number }[] = [
      { path: root, depth: rootDepth },
    ];
    const companions: {
      readonly file: FileSystemEntrySnapshot;
      readonly layout: OutsideInLayout;
    }[] = [];
    let directories = 0;
    let entries = 0;

    walk: while (queue.length > 0) {
      await this.checkpoint();
      const { path, depth } = queue.shift()!;
      directories += 1;
      if (directories > this.limits.maxDirectories) {
        truncation ??= { reason: 'directories', limit: this.limits.maxDirectories };
        break;
      }
      let children: readonly FileSystemEntrySnapshot[];
      try {
        children = await this.source.readDirectory(path);
      } catch (error: unknown) {
        if (this.disposed) throw new IndexStopped();
        if (path === WORKSPACE_ROOT) {
          throw new RootListingError(
            error instanceof Error ? error.message : 'The workspace could not be listed.',
          );
        }
        if (!isVanished(error)) target.unreadable.add(path);
        continue;
      }
      if (this.disposed) throw new IndexStopped();
      target.directories.add(path);

      const directoryNames = new Set(
        children.filter((child) => child.kind === 'directory').map((child) => child.name),
      );
      for (const child of children) {
        if (!isDiscoverableWorkspaceEntry(child.name, child.kind)) continue;
        entries += 1;
        if (entries > this.limits.maxEntries) {
          truncation ??= { reason: 'entries', limit: this.limits.maxEntries };
          break walk;
        }
        if (child.kind === 'directory') {
          if (depth + 1 > this.limits.maxDepth) {
            truncation ??= { reason: 'depth', limit: this.limits.maxDepth };
          } else {
            queue.push({ path: child.path, depth: depth + 1 });
          }
          continue;
        }
        const kind = classify(child);
        target.files.set(child.path, this.fileOf(child, kind));
        if (kind === 'markdown') {
          target.documents.set(child.path, this.markdownState(child, previous.get(child.path)));
        } else if (kind === 'outside-in') {
          const layout = resolveOutsideInLayout(child.path)!;
          if (directoryNames.has(layout.companionName)) {
            companions.push({ file: child, layout });
          } else {
            target.documents.set(
              child.path,
              this.outsideInState(child, layout, null, previous.get(child.path)),
            );
          }
        }
      }
      if (progressive) this.maybePublish();
    }

    for (const { file, layout } of companions) {
      await this.checkpoint();
      const source = await this.companionSource(layout);
      target.documents.set(
        file.path,
        this.outsideInState(file, layout, source, previous.get(file.path)),
      );
    }
    return truncation;
  }

  /** The Markdown companion an outside-in document is edited through. */
  private async companionSource(layout: OutsideInLayout): Promise<FileSystemEntrySnapshot | null> {
    let companion: readonly FileSystemEntrySnapshot[];
    try {
      companion = await this.source.readDirectory(parseWorkspacePath(layout.companionDirectory));
    } catch (error: unknown) {
      if (this.disposed) throw new IndexStopped();
      if (!isVanished(error)) this.readIssues += 1;
      return null;
    }
    const files = companion.filter((entry) => entry.kind === 'file');
    const chosen = chooseOutsideInMarkdownPath(
      layout,
      files.map((entry) => entry.path),
    );
    return chosen ? (files.find((entry) => entry.path === chosen) ?? null) : null;
  }

  private fileOf(entry: FileSystemEntrySnapshot, kind: WorkspaceIndexFileKind): IndexedFile {
    return {
      path: entry.path,
      name: entry.name,
      size: entry.kind === 'file' ? entry.size : 0,
      lastModified: entry.lastModified,
      kind,
      version: entry.version,
    };
  }

  private markdownState(
    entry: FileSystemEntrySnapshot,
    previous: DocumentState | undefined,
  ): DocumentState {
    return this.documentState(
      {
        path: entry.path,
        sourcePath: entry.path,
        format: 'markdown',
        lastModified: entry.lastModified,
      },
      entry.version,
      entry.kind === 'file' ? entry.size : 0,
      null,
      previous,
    );
  }

  private outsideInState(
    entry: FileSystemEntrySnapshot,
    layout: OutsideInLayout,
    source: FileSystemEntrySnapshot | null,
    previous: DocumentState | undefined,
  ): DocumentState {
    return this.documentState(
      {
        path: entry.path,
        sourcePath: source?.path ?? null,
        format: layout.format,
        lastModified: entry.lastModified,
      },
      source?.version ?? null,
      source?.kind === 'file' ? source.size : 0,
      layout,
      previous,
    );
  }

  private documentState(
    identity: DocumentIdentity,
    sourceVersion: FileSystemVersion | null,
    sourceSize: number,
    layout: OutsideInLayout | null,
    previous: DocumentState | undefined,
  ): DocumentState {
    const state: DocumentState = {
      identity,
      sourceVersion,
      sourceSize,
      layout,
      analysis: null,
      analysisVersion: null,
    };
    if (identity.sourcePath === null) {
      state.analysis = nameOnlyDocument(identity, 'no-companion');
    } else if (sourceSize > this.limits.maxDocumentBytes) {
      state.analysis = nameOnlyDocument(identity, 'too-large');
    } else if (
      previous?.analysis &&
      previous.identity.sourcePath === identity.sourcePath &&
      previous.analysisVersion !== null &&
      previous.analysisVersion === sourceVersion
    ) {
      state.analysis = {
        record: { ...previous.analysis.record, lastModified: identity.lastModified },
        text: previous.analysis.text,
      };
      state.analysisVersion = previous.analysisVersion;
    }
    return state;
  }

  // ── Incremental changes ───────────────────────────────────────────────

  private async applyChanges(paths: readonly WorkspacePath[]): Promise<void> {
    for (const path of paths) {
      await this.checkpoint();
      await this.applyChange(path);
    }
    this.afterStructuralChange();
    this.publish();
  }

  private async applyChange(path: WorkspacePath): Promise<void> {
    if (path === WORKSPACE_ROOT) {
      this.walkRequested = true;
      return;
    }
    const segments = path.split('/');
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index]!;
      if (isCompanionDirectoryName(segment)) {
        await this.refreshCompanion(segments.slice(0, index + 1).join('/'));
        return;
      }
      if (!isDiscoverableWorkspaceEntry(segment, 'directory')) return;
    }

    let entry: FileSystemEntrySnapshot | null;
    try {
      entry = await this.source.stat(path);
    } catch (error: unknown) {
      if (this.disposed) throw new IndexStopped();
      if (!isVanished(error)) {
        // Unknown state: a full walk re-establishes the truth.
        this.walkRequested = true;
        return;
      }
      entry = null;
    }
    if (this.disposed) throw new IndexStopped();

    const name = segments[segments.length - 1]!;
    if (entry === null) {
      this.removeSubtree(path);
      if (isCompanionDirectoryName(name)) await this.refreshCompanion(path);
      return;
    }
    if (entry.kind === 'directory') {
      if (isCompanionDirectoryName(name)) {
        await this.refreshCompanion(path);
        return;
      }
      if (!isDiscoverableWorkspaceEntry(name, 'directory')) return;
      const previous = new Map(this.tree.documents);
      this.removeSubtree(path);
      const truncation = await this.listTree(this.tree, previous, path, segments.length, false);
      this.truncation ??= truncation;
      return;
    }
    if (!isDiscoverableWorkspaceEntry(name, 'file')) return;
    const kind = classify(entry);
    this.tree.files.set(path, this.fileOf(entry, kind));
    const previous = this.tree.documents.get(path);
    if (kind === 'markdown') {
      this.tree.documents.set(path, this.markdownState(entry, previous));
    } else if (kind === 'outside-in') {
      const layout = resolveOutsideInLayout(path)!;
      const source = await this.companionSource(layout);
      this.tree.documents.set(path, this.outsideInState(entry, layout, source, previous));
    }
  }

  /** Re-resolve the outside-in documents whose companion folder is `companion`. */
  private async refreshCompanion(companion: string): Promise<void> {
    for (const state of [...this.tree.documents.values()]) {
      const layout = state.layout;
      if (!layout || layout.companionDirectory !== companion) continue;
      const file = this.tree.files.get(state.identity.path);
      if (!file) continue;
      const source = await this.companionSource(layout);
      const entry: FileSystemEntrySnapshot = {
        kind: 'file',
        path: file.path,
        name: file.name,
        size: file.size,
        version: file.version,
        lastModified: file.lastModified,
      };
      this.tree.documents.set(file.path, this.outsideInState(entry, layout, source, state));
    }
  }

  private removeSubtree(path: WorkspacePath): void {
    const within = (candidate: WorkspacePath) => workspacePathContains(path, candidate);
    for (const key of [...this.tree.files.keys()]) if (within(key)) this.tree.files.delete(key);
    for (const key of [...this.tree.documents.keys()]) {
      if (within(key)) this.tree.documents.delete(key);
    }
    for (const key of [...this.tree.directories])
      if (within(key)) this.tree.directories.delete(key);
    for (const key of [...this.tree.unreadable]) if (within(key)) this.tree.unreadable.delete(key);
  }

  /** Recount totals and requeue analysis after the tree changed shape. */
  private afterStructuralChange(): void {
    let analyzed = 0;
    let characters = 0;
    for (const state of this.tree.documents.values()) {
      if (state.analysis && state.analysis.record.content !== 'name-only') analyzed += 1;
      characters += state.analysis?.text?.characters ?? 0;
    }
    this.analyzedCount = analyzed;
    this.textCharacters = characters;
    this.queueDirty = true;
  }

  // ── Analysis ──────────────────────────────────────────────────────────

  private nextPendingDocument(): DocumentState | null {
    while (this.priority.length > 0) {
      const path = this.priority.shift()!;
      const state = this.tree.documents.get(path);
      if (state && state.analysis === null) return state;
    }
    if (this.queueDirty) {
      this.queue = [...this.tree.documents.values()]
        .filter((state) => state.analysis === null)
        .sort(
          (left, right) =>
            compareCodeUnits(right.identity.lastModified, left.identity.lastModified) ||
            compareCodeUnits(left.identity.path, right.identity.path),
        );
      this.queueIndex = 0;
      this.queueDirty = false;
    }
    while (this.queueIndex < this.queue.length) {
      const state = this.queue[this.queueIndex]!;
      this.queueIndex += 1;
      if (this.tree.documents.get(state.identity.path) === state && state.analysis === null) {
        return state;
      }
    }
    return null;
  }

  private async analyze(state: DocumentState): Promise<void> {
    const { identity } = state;
    if (this.analyzedCount >= this.limits.maxDocuments) {
      state.analysis = nameOnlyDocument(identity, 'over-budget');
      this.analysisTruncation ??= { reason: 'documents', limit: this.limits.maxDocuments };
      return;
    }
    const sourcePath = identity.sourcePath!;
    let read: Awaited<ReturnType<WorkspaceIndexSource['readFile']>>;
    try {
      read = await this.source.readFile(sourcePath);
    } catch (error: unknown) {
      if (this.disposed) throw new IndexStopped();
      if (isVanished(error)) {
        this.enqueueChange(identity.path);
        state.analysis = nameOnlyDocument(identity, 'read-error');
        return;
      }
      this.readIssues += 1;
      state.analysis = nameOnlyDocument(identity, 'read-error');
      return;
    }
    if (this.disposed) throw new IndexStopped();
    if (this.tree.documents.get(identity.path) !== state) return;
    if (read === null) {
      this.enqueueChange(identity.path);
      state.analysis = nameOnlyDocument(identity, 'read-error');
      return;
    }
    await this.checkpoint();

    let analyzed: AnalyzedDocument;
    if (read.data.byteLength > this.limits.maxDocumentBytes) {
      analyzed = nameOnlyDocument(identity, 'too-large');
    } else {
      try {
        analyzed = await analyzeDocumentBytes(identity, read.data, {
          maxParseBytes: this.limits.maxParseBytes,
          signal: this.abort.signal,
        });
      } catch {
        if (this.disposed) throw new IndexStopped();
        analyzed = nameOnlyDocument(identity, 'read-error');
      }
    }
    if (this.tree.documents.get(identity.path) !== state) return;

    const characters = analyzed.text?.characters ?? 0;
    if (characters > 0 && this.textCharacters + characters > this.limits.maxTextCharacters) {
      analyzed = {
        record: { ...analyzed.record, content: 'name-only', issue: 'over-budget' },
        text: null,
      };
      this.analysisTruncation ??= { reason: 'text', limit: this.limits.maxTextCharacters };
    }
    state.analysis = analyzed;
    state.analysisVersion = read.entry.version;
    this.textCharacters += analyzed.text?.characters ?? 0;
    if (analyzed.record.content !== 'name-only') this.analyzedCount += 1;
  }

  // ── Publishing ────────────────────────────────────────────────────────

  private recordOf(state: DocumentState): IndexedDocument {
    return state.analysis?.record ?? nameOnlyDocument(state.identity, 'pending').record;
  }

  private maybePublish(): void {
    if (this.now() - this.lastPublish >= PUBLISH_INTERVAL_MS) this.publish();
  }

  private publish(): void {
    this.generation += 1;
    this.lastPublish = this.now();
    this.filesCache = null;
    this.documentsCache = null;
    this.statusCache = null;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // One consumer's failure must not starve the others.
      }
    }
  }
}

/** Create an index over one workspace. Call `start()` to begin. */
export function createWorkspaceIndex(options: WorkspaceIndexOptions): WorkspaceIndex {
  return new WorkspaceIndexImpl(options);
}
