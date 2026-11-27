import type {
  FileSystemProviderCapabilities,
  FileSystemProviderV2,
  FileSystemVersion,
} from '../filesystem/v2.js';
import type { WorkspacePath } from '../filesystem/workspace-path.js';
import type { FolderSettings } from '../folders/folder-settings.js';
import type { CatalogDocumentFormat, CatalogOutlineEntry } from '../workspace-settings/catalog.js';
import type { ChecklistProgress } from '../properties/checklist.js';
import type { DueValue, LocalDate, RepeatRule } from '../properties/dates.js';
import type { WorkspaceIndexEngine } from './engine.js';

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
  /** Used for listing when present; without it the index walks `readDirectory`. */
  readonly enumerate?: FileSystemProviderV2['enumerate'];
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
  /** Folders whose `.docblocks/folder.json` is read; the rest are ordinary folders. */
  readonly maxFolderMarkers: number;
}

export const WORKSPACE_INDEX_LIMITS: Readonly<WorkspaceIndexLimits> = Object.freeze({
  maxEntries: 50_000,
  maxDirectories: 10_000,
  maxDepth: 32,
  maxDocuments: 10_000,
  maxDocumentBytes: 4 * 1024 * 1024,
  maxParseBytes: 1024 * 1024,
  maxTextCharacters: 24_000_000,
  maxFolderMarkers: 256,
});

/**
 * Limits for an index whose text lives in a persistent store (a worker's
 * SQLite database) rather than in page memory: the page then holds only
 * names, titles and outlines, so the text budget is the store's to bound.
 */
export const WORKSPACE_INDEX_STORE_LIMITS: Readonly<WorkspaceIndexLimits> = Object.freeze({
  ...WORKSPACE_INDEX_LIMITS,
  maxEntries: 250_000,
  maxDirectories: 50_000,
  maxDocuments: 200_000,
  maxTextCharacters: Number.MAX_SAFE_INTEGER,
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
  /**
   * Where analysis results and their text are kept and searched. Default:
   * in memory for the session. The index disposes the engine with itself.
   */
  readonly engine?: WorkspaceIndexEngine;
  /**
   * Embed a search query with the engine's embedding profile, so `find()`
   * ranks by meaning as well as words. A slow or failing embedder leaves
   * that search lexical.
   */
  readonly embedQuery?: (query: string, signal: AbortSignal) => Promise<ArrayLike<number>>;
}

export type WorkspaceIndexPhase = 'idle' | 'listing' | 'analyzing' | 'ready' | 'error' | 'disposed';

export type WorkspaceIndexTruncation =
  | 'entries'
  | 'directories'
  | 'depth'
  | 'documents'
  | 'text'
  | 'folder-markers';

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
  /** 'persistent' once the engine keeps analysis across launches; absent or 'memory' otherwise. */
  readonly persistence?: 'memory' | 'persistent';
  /** True when `find()` ranks passages (the engine has a full-text index). */
  readonly ranked?: boolean;
  /**
   * Documents whose stored record was built by an earlier version of the app
   * and is being brought up to date. Until it reaches zero, fields that
   * version did not know (`due`, `checklist`, ...) may be missing from them.
   */
  readonly upgrading?: number;
}

/** A passage ranked by relevance (BM25 over titles, headings and text). */
export interface WorkspacePassageHit {
  readonly path: string;
  readonly title: string;
  /** Headings above the passage, outermost first. */
  readonly headingPath: readonly string[];
  /** 1-based inclusive source line span. */
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly snippet: string;
  /** Match ranges within `snippet`, as [start, end) UTF-16 offsets. */
  readonly ranges: ReadonlyArray<readonly [number, number]>;
  /** Higher is better; comparable within one result. */
  readonly score: number;
  /**
   * Found by meaning: the passage's embedding is near the query's, above the
   * embedding profile's measured floor. Absent for a search by words alone.
   */
  readonly meaning?: boolean;
  /** Cosine similarity to the query, for a passage found by meaning. */
  readonly similarity?: number;
  /** The passage's full text, when `WorkspaceFindOptions.text` asked for it. */
  readonly text?: string;
}

export interface WorkspaceFindOptions {
  /** Most passages; default 20. */
  readonly limit?: number;
  /** Most passages from one document; default 3. */
  readonly perDocument?: number;
  /** Match the last word as a prefix, for search as you type. */
  readonly prefix?: boolean;
  /** Documents to leave out. */
  readonly exclude?: ReadonlySet<string>;
  /**
   * The query's embedding from the index's profile, to fuse passages near in
   * meaning with those matching the words. The index fills it in itself when
   * it was given `embedQuery`.
   */
  readonly vector?: ArrayLike<number>;
  /** Include each passage's full text (to quote it to a model, say). */
  readonly text?: boolean;
}

export type WorkspaceIndexFileKind = 'markdown' | 'outside-in' | 'other';

/**
 * A folder that carries `.docblocks/folder.json`, and what the file says.
 * A file that cannot be used is reported, never passed over: a tasks folder
 * whose settings failed to read is not an ordinary folder.
 */
export interface IndexedFolderMarker {
  /** The folder the settings describe. */
  readonly path: WorkspacePath;
  /**
   * `ok`: `settings` holds. `unreadable`: the read failed, and `settings` are
   * the last ones read, if any. The others: the file is there but is not
   * settings this version can use.
   */
  readonly status: 'ok' | 'invalid' | 'unsupported-version' | 'unsupported-kind' | 'unreadable';
  readonly settings: FolderSettings | null;
  /** Version of the settings file, for writing over what was read. */
  readonly version: FileSystemVersion | null;
}

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
  | 'over-budget'
  /** Kept online by a cloud sync client; reading it would download it. */
  | 'online-only';

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
  /** When the document is due, from frontmatter `due`: a day, or a time on it. */
  readonly due?: DueValue;
  /** Its one category, from frontmatter `category`. */
  readonly category?: string;
  /** How often it comes due again once done, from frontmatter `repeat`. */
  readonly repeat?: RepeatRule;
  /** Done: the day it was finished, or `true` when frontmatter does not say when. */
  readonly completed?: LocalDate | true;
  /** Checklist items ticked out of how many, when the document has any. */
  readonly checklist?: ChecklistProgress;
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
  /**
   * Folders that say what they are for through `.docblocks/folder.json`,
   * sorted by path; the same array within a generation.
   */
  getFolderMarkers(): readonly IndexedFolderMarker[];
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
  /**
   * Passages ranked by relevance; empty when the engine cannot rank
   * (`getStatus().ranked` says which). Words, not literal text: unlike
   * `search`, it ignores case, accents and word order.
   */
  find?(query: string, options?: WorkspaceFindOptions): Promise<readonly WorkspacePassageHit[]>;
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
