import type { FileSystemProviderCapabilities, FileSystemProviderV2 } from '../filesystem/v2.js';
import type { WorkspacePath } from '../filesystem/workspace-path.js';
import type { CatalogDocumentFormat, CatalogOutlineEntry } from '../workspace-settings/catalog.js';

/**
 * What the index reads from. Only read methods are reachable, so the index
 * cannot write to a workspace by construction.
 */
export type WorkspaceIndexSource = Pick<
  FileSystemProviderV2,
  'stat' | 'readFile' | 'readDirectory'
> & {
  readonly capabilities?: Pick<FileSystemProviderCapabilities, 'watch'>;
  readonly watch?: FileSystemProviderV2['watch'];
};

export interface WorkspaceIndexLimits {
  /** Files and folders listed in total. */
  readonly maxEntries: number;
  readonly maxDirectories: number;
  readonly maxDepth: number;
  /** Documents whose text is analyzed; the rest are searchable by name only. */
  readonly maxDocuments: number;
  /** Larger documents are indexed by name only, without being read. */
  readonly maxDocumentBytes: number;
  /** Larger documents are searched line by line instead of being parsed. */
  readonly maxParseBytes: number;
  /** Total searchable text kept in memory, in UTF-16 code units. */
  readonly maxTextCharacters: number;
}

export const WORKSPACE_INDEX_LIMITS: Readonly<WorkspaceIndexLimits> = Object.freeze({
  maxEntries: 50_000,
  maxDirectories: 10_000,
  maxDepth: 32,
  maxDocuments: 10_000,
  maxDocumentBytes: 4 * 1024 * 1024,
  maxParseBytes: 1024 * 1024,
  maxTextCharacters: 24_000_000,
});

export interface WorkspaceIndexOptions {
  readonly workspaceId: string;
  readonly source: WorkspaceIndexSource;
  /** Read and parse document text (default). `false` indexes names only. */
  readonly analyze?: boolean;
  readonly limits?: Partial<WorkspaceIndexLimits>;
  /** Hands control back to the host between slices of work. */
  readonly yieldControl?: () => Promise<void>;
  /** Monotonic clock in milliseconds, for slicing and refresh pacing. */
  readonly now?: () => number;
  /** Minimum gap between unforced refreshes; default 15 s. */
  readonly minRefreshIntervalMs?: number;
  /** Window that coalesces bursts of change notifications; default 50 ms. */
  readonly changeCoalesceMs?: number;
}

export type WorkspaceIndexPhase = 'idle' | 'listing' | 'analyzing' | 'ready' | 'error' | 'disposed';

export type WorkspaceIndexTruncation = 'entries' | 'directories' | 'depth' | 'documents' | 'text';

export interface WorkspaceIndexStatus {
  readonly phase: WorkspaceIndexPhase;
  readonly fileCount: number;
  readonly documentCount: number;
  readonly analyzedCount: number;
  readonly pendingCount: number;
  /** True while provider change events keep the index current. */
  readonly watching: boolean;
  /** True once the whole workspace has been listed at least once. */
  readonly listed: boolean;
  readonly truncated: { readonly reason: WorkspaceIndexTruncation; readonly limit: number } | null;
  /** Folders or documents that could not be read; never reported as absent. */
  readonly issues: number;
  /** Why the workspace root could not be listed. */
  readonly error: string | null;
  /** Advances whenever the published files, documents, or status change. */
  readonly generation: number;
}

export type WorkspaceIndexFileKind = 'markdown' | 'outside-in' | 'other';

export interface WorkspaceIndexFile {
  readonly path: WorkspacePath;
  readonly name: string;
  readonly size: number;
  readonly lastModified: string;
  readonly kind: WorkspaceIndexFileKind;
}

export type IndexedDocumentContent = 'full' | 'lines' | 'name-only';

export type IndexedDocumentIssue =
  | 'pending'
  | 'too-large'
  | 'parse-limit'
  | 'not-utf8'
  | 'read-error'
  | 'no-companion'
  | 'over-budget';

export interface IndexedDocument {
  /** Navigation identity: the rendered file for outside-in documents. */
  readonly path: WorkspacePath;
  /** The Markdown actually read (the companion for outside-in documents). */
  readonly sourcePath: WorkspacePath | null;
  readonly format: CatalogDocumentFormat;
  readonly lastModified: string;
  readonly title: string;
  readonly outline: readonly CatalogOutlineEntry[];
  readonly wordCount: number;
  readonly excerpt?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  /** `full` = parsed text, `lines` = raw source lines, `name-only` = not searchable by content. */
  readonly content: IndexedDocumentContent;
  readonly issue?: IndexedDocumentIssue;
}

export interface WorkspaceSearchQuery {
  readonly text: string;
  readonly matchCase?: boolean;
  readonly wholeWord?: boolean;
}

export interface WorkspaceSearchLimits {
  readonly maxQueryCharacters: number;
  readonly maxDocuments: number;
  readonly maxLinesPerDocument: number;
  readonly maxMatchesPerDocument: number;
  readonly maxTotalMatches: number;
}

export const WORKSPACE_SEARCH_LIMITS: Readonly<WorkspaceSearchLimits> = Object.freeze({
  maxQueryCharacters: 256,
  maxDocuments: 200,
  maxLinesPerDocument: 50,
  maxMatchesPerDocument: 1_000,
  maxTotalMatches: 100_000,
});

export type WorkspaceSearchRange = readonly [start: number, end: number];

export type WorkspaceSearchLineKind = 'text' | 'heading' | 'code' | 'frontmatter';

export interface WorkspaceSearchLineMatch {
  /** 1-based source line. */
  readonly line: number;
  readonly kind: WorkspaceSearchLineKind;
  readonly snippet: string;
  /** Match ranges within `snippet`. */
  readonly ranges: readonly WorkspaceSearchRange[];
  /** 0-based index, in document order, of this line's first match. */
  readonly occurrence: number;
}

export interface WorkspaceSearchDocument {
  readonly path: WorkspacePath;
  readonly title: string;
  readonly format: CatalogDocumentFormat;
  readonly titleMatch: boolean;
  readonly titleRanges: readonly WorkspaceSearchRange[];
  readonly matchCount: number;
  readonly matches: readonly WorkspaceSearchLineMatch[];
  /** More matching lines exist than `matches` lists. */
  readonly moreMatches: boolean;
  readonly lastModified: string;
  /** Not analyzed yet; only its name could be matched. */
  readonly pending: boolean;
}

export interface WorkspaceSearchResult {
  readonly documents: readonly WorkspaceSearchDocument[];
  readonly totalDocuments: number;
  readonly totalMatches: number;
  /** Result caps were reached; more matches exist than were counted or shown. */
  readonly truncated: boolean;
  /** Documents not analyzed yet, so their content was not searched. */
  readonly pendingDocuments: number;
  /** Documents that will never be content-searched (too large, unreadable, over budget). */
  readonly skippedDocuments: number;
}

export interface WorkspaceIndex {
  readonly workspaceId: string;
  getStatus(): WorkspaceIndexStatus;
  /** Called after every published change; read state through the getters. */
  subscribe(listener: () => void): () => void;
  /** Begin listing and analysis. Idempotent. */
  start(): void;
  /** Every discoverable file, sorted by path; the same array within a generation. */
  getFiles(): readonly WorkspaceIndexFile[];
  /** Discoverable folders, including empty folders; sorted within a generation. */
  getDirectories(): readonly WorkspacePath[];
  /** Every document (Markdown and outside-in), sorted by path. */
  getDocuments(): readonly IndexedDocument[];
  getDocument(path: string): IndexedDocument | null;
  /** `unknown` while unlisted, beneath an unreadable folder, or outside coverage. */
  has(path: string): 'present' | 'absent' | 'unknown';
  /** Resolves `true` once fully listed, or `false` on timeout. */
  whenListed(options?: {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  }): Promise<boolean>;
  search(
    query: WorkspaceSearchQuery,
    options?: { readonly signal?: AbortSignal; readonly limits?: Partial<WorkspaceSearchLimits> },
  ): Promise<WorkspaceSearchResult>;
  /** Re-walk the workspace, re-reading only changed documents. Coalesced. */
  refresh(options?: { readonly force?: boolean }): void;
  /** Re-check one path (or subtree) that is known to have changed. */
  invalidate(path: string): void;
  /** Analyze these documents before others. */
  prioritize(paths: readonly string[]): void;
  /** Stop issuing provider calls until resumed (e.g. while the page is hidden). */
  setPaused(paused: boolean): void;
  /** Stop all work and release the watch subscription. Never disposes the source. */
  dispose(): void;
}
