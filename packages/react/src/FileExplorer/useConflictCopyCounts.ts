import { useEffect, useMemo, useRef, useState } from 'react';
import {
  conflictCopyScope,
  isCompanionDirectoryName,
  isReviewableConflictCopy,
  listConflictCopies,
  type ConflictCopyScope,
  type FileSystemEntry,
  type FileSystemProvider,
} from '@bendyline/docblocks/filesystem';

/** Sidecars looked at per pass; a folder with more shows badges for the first of them. */
const MAX_DOCUMENTS = 200;
const CONCURRENCY = 4;
/** Listings change in bursts (a save, a sync); count once they settle. */
const SETTLE_MS = 600;
/**
 * A listing refreshes after every save, and the documents it shows have not
 * changed. Counting again that often would be a directory read per sidecar per
 * save, which on a phone is a native call each; versions arrive rarely.
 */
const RECOUNT_INTERVAL_MS = 10_000;

interface Candidate {
  readonly path: string;
  readonly scope: ConflictCopyScope;
}

function normalise(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '');
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/**
 * Documents in these listings that could hold stored versions: only those
 * whose sidecar folder is already there, so a folder of plain documents
 * costs nothing to check.
 */
export function conflictCopyCandidates(
  listings: ReadonlyArray<readonly FileSystemEntry[]>,
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const entries of listings) {
    const sidecars = new Set(
      entries
        .filter((entry) => entry.kind === 'directory' && isCompanionDirectoryName(entry.name))
        .map((entry) => normalise(entry.path)),
    );
    if (sidecars.size === 0) continue;
    for (const entry of entries) {
      if (entry.kind !== 'file') continue;
      const dot = entry.name.lastIndexOf('.');
      if (dot <= 0) continue;
      const path = normalise(entry.path);
      const parent = parentOf(path);
      const sidecar = `${parent ? `${parent}/` : ''}${entry.name.slice(0, dot)}_files`;
      if (!sidecars.has(sidecar)) continue;
      // A published page keeps its Markdown source, and that source's versions, in the sidecar.
      const scope =
        conflictCopyScope(entry.path) ??
        ({
          directory: `${entry.path.slice(0, entry.path.length - entry.name.length)}${entry.name.slice(0, dot)}_files/conflicts`,
          source: true,
          extension: '.md',
        } satisfies ConflictCopyScope);
      candidates.push({ path, scope });
      if (candidates.length >= MAX_DOCUMENTS) return candidates;
    }
  }
  return candidates;
}

/**
 * How many versions wait for review, per document, for the documents the
 * explorer is showing. Keys are workspace paths without a leading slash.
 * Best effort and quiet: a sidecar that cannot be listed counts as none.
 */
export function useConflictCopyCounts(
  provider: FileSystemProvider | null,
  listings: ReadonlyArray<readonly FileSystemEntry[]>,
  recountIntervalMs = RECOUNT_INTERVAL_MS,
): ReadonlyMap<string, number> {
  const [counts, setCounts] = useState<ReadonlyMap<string, number>>(() => new Map());
  const candidates = useMemo(() => conflictCopyCandidates(listings), [listings]);
  // Listings are new arrays on every refresh; only a change in what would be checked matters.
  const signature = candidates.map((candidate) => candidate.path).join('\n');
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;
  const passRef = useRef(0);
  const counted = useRef({ signature: '', at: Number.NEGATIVE_INFINITY });

  useEffect(() => {
    const pass = ++passRef.current;
    if (!provider || candidatesRef.current.length === 0) {
      setCounts((current) => (current.size === 0 ? current : new Map()));
      return;
    }
    // New documents are counted as soon as the listing settles; the same ones, at most every so often.
    const sameDocuments = counted.current.signature === signature;
    const delay = sameDocuments
      ? Math.max(SETTLE_MS, counted.current.at + recountIntervalMs - Date.now())
      : SETTLE_MS;
    const timer = setTimeout(() => {
      counted.current = { signature, at: Date.now() };
      const queue = [...candidatesRef.current];
      const found = new Map<string, number>();
      const worker = async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          if (pass !== passRef.current) return;
          try {
            const copies = await listConflictCopies(provider, next.scope);
            const waiting = copies.filter(isReviewableConflictCopy).length;
            if (waiting > 0) found.set(next.path, waiting);
          } catch {
            // Unlisted is uncounted; the document's own notice still finds them on open.
          }
        }
      };
      void Promise.all(Array.from({ length: CONCURRENCY }, worker)).then(() => {
        if (pass !== passRef.current) return;
        setCounts((current) => {
          if (
            current.size === found.size &&
            [...found].every(([path, count]) => current.get(path) === count)
          ) {
            return current;
          }
          return found;
        });
      });
    }, delay);
    return () => clearTimeout(timer);
    // `listings` identity, not just the signature: a refresh is the cue that copies may have changed.
  }, [provider, signature, listings, recountIntervalMs]);

  return counts;
}
