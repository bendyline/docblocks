import type { DocumentLinkCandidate } from '@bendyline/squisq-editor-react';
import type { FileSystemEntry, FileSystemProvider } from '@bendyline/docblocks/filesystem';
import {
  FsError,
  getFileSystemProviderV2,
  parseWorkspacePath,
} from '@bendyline/docblocks/filesystem';

export const DEFAULT_DOCUMENT_DISCOVERY_LIMITS = Object.freeze({
  entries: 10_000,
  directories: 2_000,
  depth: 64,
  milliseconds: 5_000,
});

export interface DocumentDiscoveryOptions {
  readonly maxEntries?: number;
  readonly maxDirectories?: number;
  readonly maxDepth?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export class DocumentDiscoveryError extends Error {
  readonly code: 'cancelled' | 'limit' | 'timeout';

  constructor(code: DocumentDiscoveryError['code'], message: string) {
    super(message);
    this.name = 'DocumentDiscoveryError';
    this.code = code;
  }
}

function positiveLimit(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new Error(`Invalid document discovery ${label} limit.`);
  }
  return selected;
}

async function readDirectory(
  provider: FileSystemProvider,
  path: string,
): Promise<FileSystemEntry[]> {
  const providerV2 = getFileSystemProviderV2(provider);
  if (!providerV2) return provider.readDirectory(path);
  const entries = await providerV2.readDirectory(parseWorkspacePath(path));
  return entries.map((entry) => ({ kind: entry.kind, name: entry.name, path: entry.path }));
}

function cancellationError(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  return new DocumentDiscoveryError('cancelled', 'Document discovery was cancelled.');
}

async function readWithBudget(
  provider: FileSystemProvider,
  directory: string,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<FileSystemEntry[]> {
  if (signal?.aborted) throw cancellationError(signal);
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new DocumentDiscoveryError('timeout', 'Document discovery exceeded its time limit.');
  }

  return new Promise<FileSystemEntry[]>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      operation();
    };
    const onAbort = (): void => finish(() => reject(cancellationError(signal!)));
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new DocumentDiscoveryError('timeout', 'Document discovery exceeded its time limit.'),
          ),
        ),
      remaining,
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    void readDirectory(provider, directory).then(
      (entries) => finish(() => resolve(entries)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

/**
 * Collect workspace Markdown without allowing one link-dialog request to walk
 * an unbounded tree or hang forever on a stalled provider.
 */
export async function collectMarkdownFiles(
  provider: FileSystemProvider,
  root: string,
  options: DocumentDiscoveryOptions = {},
): Promise<FileSystemEntry[]> {
  const maxEntries = positiveLimit(
    options.maxEntries,
    DEFAULT_DOCUMENT_DISCOVERY_LIMITS.entries,
    'entry',
  );
  const maxDirectories = positiveLimit(
    options.maxDirectories,
    DEFAULT_DOCUMENT_DISCOVERY_LIMITS.directories,
    'directory',
  );
  const maxDepth = positiveLimit(
    options.maxDepth,
    DEFAULT_DOCUMENT_DISCOVERY_LIMITS.depth,
    'depth',
  );
  const timeoutMs = positiveLimit(
    options.timeoutMs,
    DEFAULT_DOCUMENT_DISCOVERY_LIMITS.milliseconds,
    'time',
  );
  const deadline = Date.now() + timeoutMs;
  const markdown: FileSystemEntry[] = [];
  const visited = new Set<string>();
  const pending: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  let entryCount = 0;

  while (pending.length > 0) {
    if (options.signal?.aborted) throw cancellationError(options.signal);
    const current = pending.pop()!;
    const canonical = parseWorkspacePath(current.path);
    if (visited.has(canonical)) continue;
    visited.add(canonical);
    if (visited.size > maxDirectories) {
      throw new DocumentDiscoveryError(
        'limit',
        `Document discovery exceeded ${maxDirectories} directories.`,
      );
    }

    let entries: FileSystemEntry[];
    try {
      entries = await readWithBudget(provider, canonical, deadline, options.signal);
    } catch (error: unknown) {
      if (error instanceof FsError && error.code === 'not-found') continue;
      throw error;
    }
    entryCount += entries.length;
    if (entryCount > maxEntries) {
      throw new DocumentDiscoveryError(
        'limit',
        `Document discovery exceeded ${maxEntries} entries.`,
      );
    }

    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry.kind === 'directory') {
        const lower = entry.name.toLowerCase();
        if (lower.startsWith('.') || lower === 'node_modules' || lower.endsWith('_files')) continue;
        if (current.depth >= maxDepth) {
          throw new DocumentDiscoveryError(
            'limit',
            `Document discovery exceeded a depth of ${maxDepth}.`,
          );
        }
        pending.push({ path: entry.path, depth: current.depth + 1 });
      } else if (entry.kind === 'file' && entry.name.toLowerCase().endsWith('.md')) {
        markdown.push(entry);
      }
    }
  }

  return markdown;
}

function dirname(path: string): string {
  const clean = path.replace(/^\/+/, '');
  const index = clean.lastIndexOf('/');
  return index < 0 ? '' : clean.slice(0, index);
}

export function relativeMarkdownLink(fromFile: string, toFile: string): string {
  const fromParts = fromFile.replace(/^\/+/, '').split('/').filter(Boolean);
  const toParts = toFile.replace(/^\/+/, '').split('/').filter(Boolean);
  const fromDirectory = fromParts.slice(0, -1);
  const toDirectory = toParts.slice(0, -1);
  const toBase = toParts[toParts.length - 1] ?? '';
  let common = 0;
  while (
    common < fromDirectory.length &&
    common < toDirectory.length &&
    fromDirectory[common] === toDirectory[common]
  ) {
    common += 1;
  }
  const parts = [
    ...Array(fromDirectory.length - common).fill('..'),
    ...toDirectory.slice(common),
    toBase,
  ];
  return parts.length === 0 ? toBase : parts.join('/');
}

export function createDocumentLinkCandidates(
  entries: readonly FileSystemEntry[],
  selectedFile: string,
  query: string,
): DocumentLinkCandidate[] {
  const normalizedQuery = query.trim().toLowerCase();
  const selected = parseWorkspacePath(selectedFile);
  const candidates: DocumentLinkCandidate[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'file' || parseWorkspacePath(entry.path) === selected) continue;
    const label = entry.name.replace(/\.md$/iu, '');
    const path = relativeMarkdownLink(selectedFile, entry.path);
    if (
      normalizedQuery &&
      !label.toLowerCase().includes(normalizedQuery) &&
      !path.toLowerCase().includes(normalizedQuery)
    ) {
      continue;
    }
    const description = dirname(entry.path);
    candidates.push(description ? { path, label, description } : { path, label });
  }
  candidates.sort((left, right) => left.label.localeCompare(right.label));
  return candidates;
}
