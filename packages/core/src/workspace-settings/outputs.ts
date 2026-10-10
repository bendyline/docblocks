/**
 * Regenerate a workspace's catalog outputs (catalog JSON and catalog HTML).
 *
 * One filesystem-agnostic implementation serves every surface: the shell
 * passes its v2 provider, the VS Code extension host and the CLI pass small
 * adapters over `vscode.workspace.fs` and `node:fs`. The HTML renderer is
 * injected so core never depends on `@bendyline/squisq-formats`.
 *
 * Safety rules, all enforced here rather than by callers:
 * - Outputs are written only when enabled in settings.
 * - An existing file is replaced only when it carries the DocBlocks catalog
 *   marker; a hand-written `index.html` is never clobbered.
 * - Writes are skipped when bytes (or the HTML inputs digest) are unchanged,
 *   so watchers, git, and sync clients see no churn.
 * - The walk is budgeted; over budget nothing is written rather than a
 *   truncated catalog.
 */

import type { MarkdownDocument } from '@bendyline/squisq/markdown';
import { FsError } from '../filesystem/fs-error.js';
import type {
  FileSystemEntrySnapshot,
  FileSystemProviderV2,
  FileSystemVersion,
} from '../filesystem/v2.js';
import {
  parseWorkspacePath,
  WORKSPACE_ROOT,
  type WorkspacePath,
} from '../filesystem/workspace-path.js';
import {
  buildCatalogMarkdownDocument,
  catalogEntryForUnreadable,
  catalogEntryFromDocument,
  catalogEntryFromMarkdown,
  createWorkspaceCatalog,
  isGeneratedCatalogHtml,
  isGeneratedCatalogJson,
  readCatalogHtmlDigest,
  serializeCatalogJson,
  sha256Hex,
  stampCatalogHtml,
  type CatalogEntry,
  type CatalogSource,
  type WorkspaceCatalog,
} from './catalog.js';
import {
  chooseOutsideInMarkdownPath,
  resolveOutsideInLayout,
  type OutsideInLayout,
} from './outside-in-layout.js';
import {
  resolveCatalogOutputs,
  WORKSPACE_SETTINGS_DIRECTORY,
  type ResolvedCatalogOutputs,
  type WorkspaceSettings,
} from './settings.js';

export type WorkspaceOutputsIO = Pick<
  FileSystemProviderV2,
  'stat' | 'readFile' | 'readDirectory' | 'writeFile'
>;

export interface WorkspaceOutputsRenderer {
  /** Render the catalog AST as a complete, themed, script-free HTML page. */
  renderCatalogHtml(
    document: MarkdownDocument,
    options: { readonly title: string; readonly themeId: string | undefined },
  ): string | Promise<string>;
  /** Parse rendered HTML that has no Markdown companion yet. Optional. */
  importHtml?(html: string): MarkdownDocument | Promise<MarkdownDocument>;
}

export const WORKSPACE_OUTPUT_LIMITS = {
  maxDocuments: 5_000,
  maxDirectories: 20_000,
  maxDepth: 32,
  maxDocumentBytes: 4 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxOutputBytes: 32 * 1024 * 1024,
} as const;

export type WorkspaceOutputLimits = {
  readonly [K in keyof typeof WORKSPACE_OUTPUT_LIMITS]: number;
};

/** The walk exceeded a budget; nothing was written. */
export class WorkspaceOutputsLimitError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'WorkspaceOutputsLimitError';
  }
}

interface CachedEntry {
  readonly readPath: string;
  readonly version: FileSystemVersion;
  readonly includeMarkdown: boolean;
  /** null records a file that is deliberately not listed (a generated catalog page). */
  readonly entry: CatalogEntry | null;
}

/** Per-document extraction cache keyed by path + provider version. Reuse it across runs. */
export type WorkspaceCatalogCache = Map<string, CachedEntry>;

export function createWorkspaceCatalogCache(): WorkspaceCatalogCache {
  return new Map();
}

export interface RefreshWorkspaceOutputsOptions {
  readonly cache?: WorkspaceCatalogCache;
  readonly signal?: AbortSignal;
  /** Rewrite the HTML page even when its inputs digest is unchanged. */
  readonly force?: boolean;
  /** Compute everything, write nothing. */
  readonly dryRun?: boolean;
  readonly limits?: Partial<WorkspaceOutputLimits>;
}

export type WorkspaceOutputStatus = 'written' | 'unchanged' | 'blocked' | 'would-write';

export interface WorkspaceOutputResult {
  readonly kind: 'html' | 'json';
  readonly path: WorkspacePath;
  readonly status: WorkspaceOutputStatus;
  readonly message?: string;
  /** True when this run created the file (it did not exist before). */
  readonly created?: true;
}

export interface WorkspaceOutputsResult {
  readonly documentCount: number;
  readonly outputs: readonly WorkspaceOutputResult[];
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new FsError('aborted', 'Workspace catalog refresh was cancelled.', {
      operation: 'read',
      retryable: false,
    });
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof FsError && (error.code === 'not-found' || error.code === 'type-mismatch');
}

function hasHiddenSegment(path: string): boolean {
  return path.split('/').some((segment) => segment.startsWith('.'));
}

function isExcluded(path: string, exclude: readonly string[]): boolean {
  return exclude.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Whether a changed path can affect the catalog. Used by schedulers to ignore
 * their own output writes, version snapshots, and other hidden bookkeeping.
 * `.docblocks/` changes are settings changes, handled by the caller.
 */
export function isCatalogRelevantPath(
  path: string,
  settings: WorkspaceSettings | null | undefined,
): boolean {
  const normalized = path.replace(/^\/+/, '');
  if (!normalized || hasHiddenSegment(normalized)) return false;
  if (normalized === '_squisq' || normalized.startsWith('_squisq/')) return false;
  let resolved: ResolvedCatalogOutputs | null;
  try {
    resolved = resolveCatalogOutputs(settings);
  } catch {
    return false;
  }
  if (!resolved) return false;
  const lower = normalized.toLowerCase();
  return lower !== resolved.html?.path.toLowerCase() && lower !== resolved.json?.path.toLowerCase();
}

/** True for the workspace settings directory or anything inside it. */
export function isWorkspaceSettingsPath(path: string): boolean {
  const normalized = path.replace(/^\/+/, '');
  return (
    normalized === WORKSPACE_SETTINGS_DIRECTORY ||
    normalized.startsWith(`${WORKSPACE_SETTINGS_DIRECTORY}/`)
  );
}

type Candidate =
  | { readonly kind: 'markdown'; readonly entry: FileSystemEntrySnapshot }
  | {
      readonly kind: 'outside-in';
      readonly entry: FileSystemEntrySnapshot;
      readonly layout: OutsideInLayout;
    };

async function collectCandidates(
  io: WorkspaceOutputsIO,
  resolved: ResolvedCatalogOutputs,
  limits: WorkspaceOutputLimits,
  signal: AbortSignal | undefined,
): Promise<Candidate[]> {
  const outputPaths = new Set(
    [resolved.html?.path, resolved.json?.path].filter(Boolean).map((path) => path!.toLowerCase()),
  );
  const exclude = [...resolved.exclude, 'node_modules'];
  const candidates: Candidate[] = [];
  const queue: Array<{ path: WorkspacePath; depth: number }> = [{ path: WORKSPACE_ROOT, depth: 0 }];
  let directories = 0;

  while (queue.length > 0) {
    throwIfAborted(signal);
    const { path, depth } = queue.shift()!;
    directories += 1;
    if (directories > limits.maxDirectories) {
      throw new WorkspaceOutputsLimitError(
        `This workspace has more than ${limits.maxDirectories} folders; the catalog was not updated.`,
      );
    }
    let entries: readonly FileSystemEntrySnapshot[];
    try {
      entries = await io.readDirectory(path);
    } catch (error) {
      if (path !== WORKSPACE_ROOT && isNotFound(error)) continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || isExcluded(entry.path, exclude)) continue;
      if (entry.kind === 'directory') {
        if (entry.name.endsWith('_files') || entry.name === '_squisq') continue;
        if (depth + 1 > limits.maxDepth) {
          throw new WorkspaceOutputsLimitError(
            `Folders nest deeper than ${limits.maxDepth} levels; the catalog was not updated.`,
          );
        }
        queue.push({ path: entry.path, depth: depth + 1 });
        continue;
      }
      if (outputPaths.has(entry.path.toLowerCase())) continue;
      const lower = entry.name.toLowerCase();
      if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
        candidates.push({ kind: 'markdown', entry });
      } else {
        const layout = resolveOutsideInLayout(entry.path);
        if (layout) candidates.push({ kind: 'outside-in', entry, layout });
      }
      if (candidates.length > limits.maxDocuments) {
        throw new WorkspaceOutputsLimitError(
          `This workspace has more than ${limits.maxDocuments} documents; the catalog was not updated.`,
        );
      }
    }
  }
  return candidates;
}

const HTML_TITLE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const HTML_DESCRIPTION =
  /<meta\b[^>]*\bname\s*=\s*["']description["'][^>]*\bcontent\s*=\s*["']([^"']*)["']/i;

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

interface ReadTarget {
  readonly source: CatalogSource;
  readonly readPath: string | null;
  readonly version: FileSystemVersion | null;
  /** Size from the listing, so oversized files are skipped without reading them. */
  readonly size: number | null;
  readonly mode: 'markdown' | 'html' | 'unreadable';
}

async function resolveReadTarget(
  io: WorkspaceOutputsIO,
  candidate: Candidate,
): Promise<ReadTarget> {
  if (candidate.kind === 'markdown') {
    return {
      source: { path: candidate.entry.path, format: 'markdown' },
      readPath: candidate.entry.path,
      version: candidate.entry.version,
      size: candidate.entry.size,
      mode: 'markdown',
    };
  }
  const { layout, entry } = candidate;
  let companion: readonly FileSystemEntrySnapshot[] = [];
  try {
    companion = await io.readDirectory(parseWorkspacePath(layout.companionDirectory));
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const markdownPath = chooseOutsideInMarkdownPath(
    layout,
    companion.filter((item) => item.kind === 'file').map((item) => item.path),
  );
  const markdownEntry = markdownPath
    ? companion.find((item) => item.path === markdownPath)
    : undefined;
  if (markdownEntry) {
    return {
      source: { path: entry.path, source: markdownEntry.path, format: layout.format },
      readPath: markdownEntry.path,
      version: markdownEntry.version,
      size: markdownEntry.size,
      mode: 'markdown',
    };
  }
  return {
    source: { path: entry.path, format: layout.format },
    readPath: layout.format === 'html' ? entry.path : null,
    version: layout.format === 'html' ? entry.version : null,
    size: entry.size,
    mode: layout.format === 'html' ? 'html' : 'unreadable',
  };
}

/** Walk the workspace and build its catalog without writing anything. */
export async function collectWorkspaceCatalog(
  io: WorkspaceOutputsIO,
  resolved: ResolvedCatalogOutputs,
  renderer: Pick<WorkspaceOutputsRenderer, 'importHtml'>,
  options: Omit<RefreshWorkspaceOutputsOptions, 'force' | 'dryRun'> = {},
): Promise<WorkspaceCatalog> {
  const limits: WorkspaceOutputLimits = { ...WORKSPACE_OUTPUT_LIMITS, ...options.limits };
  const cache = options.cache;
  const includeMarkdown = resolved.json?.content === 'markdown';
  const candidates = await collectCandidates(io, resolved, limits, options.signal);
  const entries: CatalogEntry[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  for (const candidate of candidates) {
    throwIfAborted(options.signal);
    const target = await resolveReadTarget(io, candidate);
    seen.add(target.source.path);
    if (
      target.mode === 'unreadable' ||
      !target.readPath ||
      (target.size !== null && target.size > limits.maxDocumentBytes)
    ) {
      entries.push(catalogEntryForUnreadable(target.source));
      continue;
    }
    const cached = cache?.get(target.source.path);
    if (
      cached &&
      cached.readPath === target.readPath &&
      cached.version === target.version &&
      cached.includeMarkdown === includeMarkdown
    ) {
      if (cached.entry) entries.push(cached.entry);
      continue;
    }

    const read = await io.readFile(parseWorkspacePath(target.readPath));
    if (!read) continue;
    let entry: CatalogEntry | null;
    if (read.entry.size > limits.maxDocumentBytes) {
      entry = catalogEntryForUnreadable(target.source);
    } else {
      totalBytes += read.entry.size;
      if (totalBytes > limits.maxTotalBytes) {
        throw new WorkspaceOutputsLimitError(
          `Documents in this workspace exceed ${Math.round(limits.maxTotalBytes / 1024 / 1024)} MiB; the catalog was not updated.`,
        );
      }
      const text = new TextDecoder('utf-8').decode(read.data);
      if (target.mode === 'markdown') {
        entry = await catalogEntryFromMarkdown(target.source, text, { includeMarkdown });
      } else if (isGeneratedCatalogHtml(text)) {
        entry = null;
      } else if (renderer.importHtml) {
        const head = text.slice(0, 64 * 1024);
        entry = await catalogEntryFromDocument(target.source, await renderer.importHtml(text), {
          fallbackTitle: decodeEntities(HTML_TITLE.exec(head)?.[1] ?? ''),
          description: decodeEntities(HTML_DESCRIPTION.exec(head)?.[1] ?? ''),
        });
      } else {
        entry = catalogEntryForUnreadable(target.source);
      }
    }
    cache?.set(target.source.path, {
      readPath: target.readPath,
      version: read.entry.version,
      includeMarkdown,
      entry,
    });
    if (entry) entries.push(entry);
  }

  if (cache) {
    for (const key of [...cache.keys()]) if (!seen.has(key)) cache.delete(key);
  }
  return createWorkspaceCatalog(resolved.title, entries, resolved.sort);
}

function withoutMarkdown(catalog: WorkspaceCatalog): WorkspaceCatalog {
  if (!catalog.documents.some((entry) => entry.markdown !== undefined)) return catalog;
  return {
    ...catalog,
    documents: catalog.documents.map(({ markdown: _markdown, ...entry }) => entry),
  };
}

function sameBytes(left: ArrayBuffer, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const view = new Uint8Array(left);
  for (let index = 0; index < view.length; index += 1) {
    if (view[index] !== right[index]) return false;
  }
  return true;
}

interface WriteOutputRequest {
  readonly kind: 'html' | 'json';
  readonly path: WorkspacePath;
  readonly produce: () => Promise<string>;
  /** HTML only: skip rendering entirely when the existing page has this digest. */
  readonly digest?: string;
}

async function writeOutput(
  io: WorkspaceOutputsIO,
  request: WriteOutputRequest,
  limits: WorkspaceOutputLimits,
  options: RefreshWorkspaceOutputsOptions,
): Promise<WorkspaceOutputResult> {
  const { kind, path } = request;
  const blocked = (message: string): WorkspaceOutputResult => ({
    kind,
    path,
    status: 'blocked',
    message,
  });

  let existing: Awaited<ReturnType<WorkspaceOutputsIO['readFile']>>;
  try {
    existing = await io.readFile(path);
  } catch (error) {
    if (error instanceof FsError && error.code === 'type-mismatch') {
      return blocked(`${path} is a folder. Choose another catalog path.`);
    }
    throw error;
  }

  if (existing) {
    const head = new TextDecoder('utf-8').decode(existing.data.slice(0, 4096));
    const generated = kind === 'html' ? isGeneratedCatalogHtml(head) : isGeneratedCatalogJson(head);
    if (!generated) {
      return blocked(
        `${path} already exists and was not created by DocBlocks. Choose another catalog path or remove that file.`,
      );
    }
    if (kind === 'html' && !options.force && readCatalogHtmlDigest(head) === request.digest) {
      return { kind, path, status: 'unchanged' };
    }
  }

  if (kind === 'html') {
    const layout = resolveOutsideInLayout(path);
    if (layout && (await io.stat(parseWorkspacePath(layout.companionDirectory)))) {
      return blocked(`${path} is an edited document. Choose another catalog path.`);
    }
  }

  const bytes = new TextEncoder().encode(await request.produce());
  if (bytes.byteLength > limits.maxOutputBytes) {
    return blocked(
      `The catalog would exceed ${Math.round(limits.maxOutputBytes / 1024 / 1024)} MiB and was not written.`,
    );
  }
  if (existing && sameBytes(existing.data, bytes)) return { kind, path, status: 'unchanged' };
  if (options.dryRun) return { kind, path, status: 'would-write' };

  await io.writeFile(path, bytes, {
    mode: existing ? 'replace' : 'create',
    createParents: true,
    expectedVersion: existing ? existing.entry.version : null,
  });
  return { kind, path, status: 'written', ...(existing ? {} : { created: true as const }) };
}

/**
 * Regenerate every enabled catalog output for one workspace. Throws
 * {@link WorkspaceOutputsLimitError} when over budget, `FsError('aborted')`
 * when cancelled, and propagates storage errors (including `conflict` when a
 * concurrent writer won, which callers should answer with one re-run).
 */
export async function refreshWorkspaceOutputs(
  io: WorkspaceOutputsIO,
  settings: WorkspaceSettings | null | undefined,
  renderer: WorkspaceOutputsRenderer,
  options: RefreshWorkspaceOutputsOptions = {},
): Promise<WorkspaceOutputsResult> {
  const resolved = resolveCatalogOutputs(settings);
  if (!resolved) return { documentCount: 0, outputs: [] };
  const limits: WorkspaceOutputLimits = { ...WORKSPACE_OUTPUT_LIMITS, ...options.limits };

  const catalog = await collectWorkspaceCatalog(io, resolved, renderer, options);
  const metadataCatalog = withoutMarkdown(catalog);
  const outputs: WorkspaceOutputResult[] = [];

  if (resolved.json) {
    throwIfAborted(options.signal);
    const content = resolved.json.content;
    outputs.push(
      await writeOutput(
        io,
        {
          kind: 'json',
          path: resolved.json.path,
          produce: async () =>
            serializeCatalogJson(content === 'markdown' ? catalog : metadataCatalog),
        },
        limits,
        options,
      ),
    );
  }

  if (resolved.html) {
    throwIfAborted(options.signal);
    const html = resolved.html;
    const digest = await sha256Hex(
      JSON.stringify({
        marker: 1,
        path: html.path,
        themeId: html.themeId ?? null,
        catalog: serializeCatalogJson(metadataCatalog),
      }),
    );
    outputs.push(
      await writeOutput(
        io,
        {
          kind: 'html',
          path: html.path,
          digest,
          produce: async () =>
            stampCatalogHtml(
              await renderer.renderCatalogHtml(
                buildCatalogMarkdownDocument(metadataCatalog, html.path),
                { title: catalog.title, themeId: html.themeId },
              ),
              digest,
            ),
        },
        limits,
        options,
      ),
    );
  }

  return { documentCount: catalog.documents.length, outputs };
}
