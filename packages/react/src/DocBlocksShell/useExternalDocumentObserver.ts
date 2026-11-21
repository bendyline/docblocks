import { useCallback, useEffect, useRef } from 'react';
import type { DocumentSession } from '@bendyline/docblocks/document';
import {
  decodeUtf8Text,
  getFileSystemProviderV2,
  parseWorkspacePath,
  type FileSystemProvider,
} from '@bendyline/docblocks/filesystem';
import { subscribeRevalidationSignal } from '../hooks/revalidation-signal.js';

export interface StableFileSnapshot {
  content: string | null;
  version: string | null;
  lastModified: string | null;
}

/** Read a document together with the version that content belongs to. */
export async function readStableFileSnapshot(
  provider: FileSystemProvider,
  path: string,
): Promise<StableFileSnapshot> {
  const providerV2 = getFileSystemProviderV2(provider);
  if (providerV2) {
    const read = await providerV2.readFile(parseWorkspacePath(path));
    return {
      content: read
        ? decodeUtf8Text(read.data, {
            label: 'The document',
            path: parseWorkspacePath(path),
          })
        : null,
      version: read?.entry.version ?? null,
      lastModified: read?.entry.lastModified ?? null,
    };
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await provider.stat(path);
    const content = await provider.readFile(path);
    const after = await provider.stat(path);
    const unchanged = before?.lastModified === after?.lastModified && before?.size === after?.size;
    const existenceMatches = (content !== null) === (after !== null);
    if (unchanged && existenceMatches) {
      return {
        content,
        version: after ? `${after.lastModified}:${after.size}` : null,
        lastModified: after?.lastModified ?? null,
      };
    }
  }
  throw new Error('The file kept changing while DocBlocks was reading it.');
}

export interface ExternalDocumentObserverOptions {
  provider: FileSystemProvider | null;
  /** The file backing the open document, or null when nothing should be observed. */
  path: string | null;
  targetKey: string | null;
  session: Pick<DocumentSession, 'observeExternal'>;
  /**
   * Changes whenever something known rewrote the open file without the
   * provider reporting it (a catalog run on a provider that cannot watch).
   * Each new truthy value triggers one observation.
   */
  refreshToken?: unknown;
  /**
   * Re-check interval while the document is visible, for storage that cannot
   * report changes by itself. Ignored when the provider watches.
   */
  heartbeatMs?: number | null;
  /** A change was reported but the file could not be read. Quiet re-checks never call this. */
  onCheckFailed?: () => void;
}

/**
 * Why the file is being looked at.
 * - `reported`: something said it changed (a watch event, a known rewrite).
 * - `revalidation`: the app came back; read it in full, quietly.
 * - `heartbeat`: a periodic check, or an unspecific report that storage
 *   changed somewhere; read only when the version moved.
 */
type ObservationKind = 'reported' | 'revalidation' | 'heartbeat';

const OBSERVATION_STRENGTH: Record<ObservationKind, number> = {
  heartbeat: 0,
  revalidation: 1,
  reported: 2,
};

function strongerObservation(a: ObservationKind, b: ObservationKind): ObservationKind {
  return OBSERVATION_STRENGTH[a] >= OBSERVATION_STRENGTH[b] ? a : b;
}

/**
 * Keep the document session in step with the file underneath it.
 *
 * Three things trigger a look at the file: a watch event for it, a
 * revalidation moment (focus, resume, network back, first touch after a quiet
 * spell), and an optional heartbeat for storage that cannot watch. The session
 * decides what an observed change means: a clean buffer adopts it, unsaved
 * edits become a conflict.
 *
 * Returns a way to look at the file now. It resolves once the session has
 * been shown what storage holds (or at once when nothing is being observed),
 * and never rejects: a caller about to act on "the session is up to date"
 * asks the session again afterwards whatever happened.
 */
export function useExternalDocumentObserver(
  options: ExternalDocumentObserverOptions,
): () => Promise<void> {
  const { provider, path, targetKey, session, refreshToken, heartbeatMs } = options;
  // The session ignores a sequence it has already seen and only starts over
  // when the document changes, so this counter must outlive every re-run of
  // the effect below.
  const sequenceRef = useRef(0);
  const onCheckFailedRef = useRef(options.onCheckFailed);
  onCheckFailedRef.current = options.onCheckFailed;
  const checkNowRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    if (!provider || !path || !targetKey) return;
    const providerV2 = getFileSystemProviderV2(provider);
    if (!providerV2) return;
    const canonicalPath = parseWorkspacePath(path);
    let disposed = false;
    // The read loop in flight, if any; it also covers whatever is `pending`.
    let reading: Promise<void> | null = null;
    let pending: ObservationKind | null = null;
    // Version of the content last handed to the session; undefined until the first read.
    let observedVersion: string | null | undefined;

    const observeOnce = async (kind: ObservationKind): Promise<void> => {
      if (kind === 'heartbeat' && observedVersion !== undefined) {
        // The heartbeat asks for the version first, so an unchanged file costs
        // one small request instead of a full read.
        const entry = await providerV2.stat(canonicalPath);
        if (disposed || (entry?.kind === 'file' && entry.version === observedVersion)) return;
      }
      const sequence = ++sequenceRef.current;
      const external = await readStableFileSnapshot(provider, path);
      if (disposed) return;
      observedVersion = external.version;
      // The session decides whether this is a clean update or a conflict.
      const modifiedAt = external.lastModified ? Date.parse(external.lastModified) : Number.NaN;
      session.observeExternal({
        targetKey,
        sequence,
        content: external.content,
        version: external.version,
        // When it was written tells the session which other versions can have been built on it.
        ...(Number.isFinite(modifiedAt) ? { origin: { modifiedAt } } : {}),
      });
    };

    const observe = (kind: ObservationKind): Promise<void> => {
      if (reading) {
        // One follow-up read covers everything that arrived meanwhile.
        pending = pending === null ? kind : strongerObservation(pending, kind);
        return reading;
      }
      const run = async (): Promise<void> => {
        let current = kind;
        try {
          for (;;) {
            try {
              await observeOnce(current);
            } catch {
              // Precautionary checks stay quiet: being offline is not news.
              if (!disposed && current === 'reported') onCheckFailedRef.current?.();
            }
            if (disposed || pending === null) return;
            current = pending;
            pending = null;
          }
        } finally {
          reading = null;
        }
      };
      reading = run();
      return reading;
    };
    const checkNow = () => observe('revalidation');
    checkNowRef.current = checkNow;

    const watching = providerV2.capabilities.watch;
    const subscription = watching
      ? providerV2.watch(
          (event) => {
            if (event.type === 'overflow') {
              void observe('reported');
              return;
            }
            const changedCurrent = parseWorkspacePath(event.path) === canonicalPath;
            const changedDestination =
              event.destinationPath !== null &&
              parseWorkspacePath(event.destinationPath) === canonicalPath;
            if (changedCurrent || changedDestination) void observe('reported');
          },
          {
            // Re-read the file when the watcher fails; the session decides
            // whether the result is a clean update or an external conflict.
            onError: () => void observe('reported'),
          },
        )
      : null;
    void subscription?.ready.catch(() => undefined);

    // Coming back reads the file in full. A storage report arrives often,
    // this app's own saves included, so it asks for the version first.
    const stopSignal = subscribeRevalidationSignal(
      (reason) => void observe(reason === 'storage' ? 'heartbeat' : 'revalidation'),
    );
    const heartbeat =
      !watching && heartbeatMs
        ? setInterval(() => {
            if (document.visibilityState === 'visible') void observe('heartbeat');
          }, heartbeatMs)
        : null;
    if (refreshToken) void observe('reported');

    return () => {
      disposed = true;
      if (checkNowRef.current === checkNow) checkNowRef.current = null;
      stopSignal();
      if (heartbeat !== null) clearInterval(heartbeat);
      void subscription?.dispose();
    };
  }, [provider, path, targetKey, session, refreshToken, heartbeatMs]);

  return useCallback(() => checkNowRef.current?.() ?? Promise.resolve(), []);
}
