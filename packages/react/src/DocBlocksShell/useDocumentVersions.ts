import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  conflictCopyScope,
  getFileSystemProviderV2,
  PREMERGE_COPY_LIFETIME_MS,
  PREMERGE_COPY_LIMIT,
  isReviewableConflictCopy,
  listConflictCopies,
  pruneConflictCopies,
  type ConflictCopy,
  type ConflictCopyScope,
  type FileSystemProvider,
} from '@bendyline/docblocks/filesystem';
import { subscribeRevalidationSignal } from '../hooks/revalidation-signal.js';

export interface DocumentVersionsOptions {
  provider: FileSystemProvider | null;
  /** The document as the user sees it (`Page.html`, `Notes/Unicorns.md`). */
  documentPath: string | null;
  /** The Markdown the session edits, when that is a different file (an outside-in source). */
  sourcePath?: string | null;
  /** Any value that changes when the document was replaced by a merge or an outside version. */
  refreshToken?: unknown;
  /** Re-list on this cadence where storage reports no changes by itself. */
  heartbeatMs?: number | null;
}

export interface DocumentVersions {
  /** Null for a document that keeps no sidecar, and so has no stored versions. */
  readonly scope: ConflictCopyScope | null;
  /** Versions waiting for the user to look at them, newest first. */
  readonly copies: readonly ConflictCopy[];
  /** Texts kept from before the app combined or replaced something, newest first. */
  readonly undoCopies: readonly ConflictCopy[];
  /** List again now. Resolves when the list is current. */
  refresh(): Promise<void>;
}

const NO_COPIES: readonly ConflictCopy[] = Object.freeze([]);
const WATCH_SETTLE_MS = 250;

function comparable(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '');
}

function sameCopies(a: readonly ConflictCopy[], b: readonly ConflictCopy[]): boolean {
  return a.length === b.length && a.every((copy, index) => copy.path === b[index]!.path);
}

/**
 * The other versions of the open document that are waiting in its sidecar:
 * what a sync service set aside, and unsaved text this app set aside so the
 * user could move on. Listing is best effort and silent: a version that could
 * not be listed now is still there next time.
 */
export function useDocumentVersions({
  provider,
  documentPath,
  sourcePath = null,
  refreshToken,
  heartbeatMs = null,
}: DocumentVersionsOptions): DocumentVersions {
  const scope = useMemo(
    () => (provider && documentPath ? conflictCopyScope(documentPath, sourcePath) : null),
    [provider, documentPath, sourcePath],
  );
  const [copies, setCopies] = useState<readonly ConflictCopy[]>(NO_COPIES);
  const [undoCopies, setUndoCopies] = useState<readonly ConflictCopy[]>(NO_COPIES);
  const requestRef = useRef(0);

  const list = useCallback(
    async (tidy: boolean): Promise<void> => {
      const request = ++requestRef.current;
      if (!provider || !scope) {
        setCopies(NO_COPIES);
        setUndoCopies(NO_COPIES);
        return;
      }
      let listed: readonly ConflictCopy[];
      let kept: readonly ConflictCopy[];
      try {
        const all = await listConflictCopies(provider, scope);
        listed = all.filter(isReviewableConflictCopy);
        kept = all.filter((copy) => copy.origin === 'premerge');
        // Undo copies past their week go, from the listing already in hand;
        // so do the oldest once a long session has left too many.
        const now = Date.now();
        const undo = all.filter((copy) => copy.origin === 'premerge');
        if (
          undo.length > PREMERGE_COPY_LIMIT ||
          (tidy && undo.some((copy) => now - copy.capturedAt >= PREMERGE_COPY_LIFETIME_MS))
        ) {
          await pruneConflictCopies(provider, scope, now).catch(() => 0);
        }
      } catch {
        return;
      }
      if (request !== requestRef.current) return;
      setCopies((current) => (sameCopies(current, listed) ? current : listed));
      setUndoCopies((current) => (sameCopies(current, kept) ? current : kept));
    },
    [provider, scope],
  );
  const load = useCallback(() => list(false), [list]);

  // A new document starts empty, then lists and tidies once.
  useEffect(() => {
    setCopies(NO_COPIES);
    setUndoCopies(NO_COPIES);
    if (!provider || !scope) return;
    void list(true);
    return () => {
      requestRef.current += 1;
    };
  }, [provider, scope, list]);

  useEffect(() => {
    if (refreshToken === undefined) return;
    void load();
  }, [refreshToken, load]);

  useEffect(() => {
    if (!provider || !scope) return;
    const stopSignal = subscribeRevalidationSignal(() => void load());
    const providerV2 = getFileSystemProviderV2(provider);
    const watching = providerV2?.capabilities.watch === true;
    let settle: ReturnType<typeof setTimeout> | null = null;
    const directory = comparable(scope.directory);
    const subscription = watching
      ? providerV2.watch(
          (event) => {
            const touched =
              event.type === 'overflow' ||
              [event.path, event.destinationPath].some(
                (path) =>
                  path !== null &&
                  (comparable(path) === directory || comparable(path).startsWith(`${directory}/`)),
              );
            if (!touched) return;
            if (settle) clearTimeout(settle);
            settle = setTimeout(() => void load(), WATCH_SETTLE_MS);
          },
          { onError: () => undefined },
        )
      : null;
    void subscription?.ready.catch(() => undefined);
    const heartbeat =
      !watching && heartbeatMs
        ? setInterval(() => {
            if (typeof document === 'undefined' || document.visibilityState === 'visible') {
              void load();
            }
          }, heartbeatMs)
        : null;
    return () => {
      stopSignal();
      if (settle) clearTimeout(settle);
      if (heartbeat) clearInterval(heartbeat);
      void subscription?.dispose().catch(() => undefined);
    };
  }, [provider, scope, heartbeatMs, load]);

  return useMemo(
    () => ({ scope, copies, undoCopies, refresh: load }),
    [scope, copies, undoCopies, load],
  );
}
