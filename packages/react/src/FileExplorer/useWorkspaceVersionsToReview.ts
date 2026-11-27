import { useEffect, useRef, useState } from 'react';
import {
  WORKSPACE_ROOT,
  getFileSystemProviderV2,
  isReviewableConflictCopy,
  listConflictCopies,
  type FileSystemEntry,
  type FileSystemProvider,
} from '@bendyline/docblocks/filesystem';
import { subscribeRevalidationSignal } from '../hooks/revalidation-signal.js';
import { conflictCopyCandidates } from './useConflictCopyCounts.js';

export interface DocumentToReview {
  /** Workspace path without a leading slash. */
  readonly path: string;
  readonly count: number;
}

const NONE: readonly DocumentToReview[] = Object.freeze([]);
/** Looking through a whole workspace is not free; coming back to the app is cue enough. */
const MIN_INTERVAL_MS = 60_000;
const FIRST_LOOK_DELAY_MS = 1_500;
const MAX_ENTRIES = 50_000;
const CONCURRENCY = 4;

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/**
 * Every document in the workspace with other versions waiting for review,
 * including those in folders the explorer has not opened. A sync helper can
 * set a version aside for a document nobody has looked at in weeks; without
 * this, it would wait unseen until someone happened to expand its folder.
 *
 * Runs only on storage that both watches and can list a whole workspace from
 * metadata (`enumerate`): the desktop app. A phone can enumerate too, but as
 * one native call per folder, and a pass like this right after a conflict is
 * exactly when its storage is busiest. Elsewhere the per-row badges and the
 * open document's own notice still apply.
 */
export function useWorkspaceVersionsToReview(
  provider: FileSystemProvider | null,
  /** Changes when the explorer's own counts do: a cue that copies came or went. */
  refreshToken: unknown,
): readonly DocumentToReview[] {
  const [documents, setDocuments] = useState<readonly DocumentToReview[]>(NONE);
  const lastLookRef = useRef(Number.NEGATIVE_INFINITY);
  const lookRef = useRef<(force: boolean) => void>(() => undefined);

  useEffect(() => {
    setDocuments(NONE);
    lastLookRef.current = Number.NEGATIVE_INFINITY;
    const providerV2 = provider ? getFileSystemProviderV2(provider) : null;
    const enumerate = providerV2?.capabilities.watch
      ? providerV2.enumerate?.bind(providerV2)
      : undefined;
    if (!provider || !enumerate) {
      lookRef.current = () => undefined;
      return;
    }
    let disposed = false;
    let looking = false;
    const abort = new AbortController();

    const look = async (): Promise<void> => {
      const byFolder = new Map<string, FileSystemEntry[]>();
      let seen = 0;
      for await (const page of enumerate(WORKSPACE_ROOT, { signal: abort.signal })) {
        for (const entry of page.entries) {
          seen += 1;
          if (seen > MAX_ENTRIES) break;
          const folder = parentOf(entry.path);
          const listing = byFolder.get(folder) ?? [];
          listing.push({ kind: entry.kind, name: entry.name, path: entry.path });
          byFolder.set(folder, listing);
        }
        if (seen > MAX_ENTRIES || disposed) break;
      }
      const queue = conflictCopyCandidates([...byFolder.values()]);
      const found: DocumentToReview[] = [];
      const worker = async () => {
        for (let next = queue.shift(); next && !disposed; next = queue.shift()) {
          try {
            const waiting = (await listConflictCopies(provider, next.scope)).filter(
              isReviewableConflictCopy,
            ).length;
            if (waiting > 0) found.push({ path: next.path, count: waiting });
          } catch {
            // A sidecar that cannot be listed is simply not reported.
          }
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      if (disposed) return;
      found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      setDocuments((current) =>
        current.length === found.length &&
        found.every(
          (item, index) =>
            current[index]!.path === item.path && current[index]!.count === item.count,
        )
          ? current
          : found,
      );
    };

    const request = (force: boolean) => {
      if (disposed || looking) return;
      const now = Date.now();
      if (!force && now - lastLookRef.current < MIN_INTERVAL_MS) return;
      lastLookRef.current = now;
      looking = true;
      void look()
        .catch(() => undefined)
        .finally(() => {
          looking = false;
        });
    };
    lookRef.current = request;

    const first = setTimeout(() => request(true), FIRST_LOOK_DELAY_MS);
    // Not for `storage`: that also follows this app's own saves, far too often for a full pass.
    const stopSignal = subscribeRevalidationSignal((reason) => {
      if (reason !== 'storage') request(false);
    });
    return () => {
      disposed = true;
      abort.abort();
      clearTimeout(first);
      stopSignal();
    };
  }, [provider]);

  // The explorer saw a count change in a folder it shows: the workspace-wide list is stale.
  const firstToken = useRef(true);
  useEffect(() => {
    if (firstToken.current) {
      firstToken.current = false;
      return;
    }
    const timer = setTimeout(() => lookRef.current(true), FIRST_LOOK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [refreshToken]);

  return documents;
}
