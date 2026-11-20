/**
 * Semantic search's embedder over `host.embeddings`: the host's bundled
 * model, reached through the bridge in wire-sized batches.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  EMBEDDINGS_WIRE_LIMITS,
  maybeGetDocBlocksHost,
  type DocBlocksHostEmbeddingsAPI,
  type EmbeddingsStatus,
} from '@bendyline/docblocks/host';
import type { WorkspaceIndexEmbedder } from './embedding-scheduler.js';

function abortError(): Error {
  const error = new Error('Embedding stopped.');
  error.name = 'AbortError';
  return error;
}

/** Split texts into requests the bridge accepts, cutting each at the embedder's own cap. */
export function embeddingBatches(texts: readonly string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let characters = 0;
  for (const raw of texts) {
    const text = raw.split('\0').join('').slice(0, EMBEDDINGS_WIRE_LIMITS.textCharacters);
    if (
      current.length > 0 &&
      (current.length >= EMBEDDINGS_WIRE_LIMITS.texts ||
        characters + text.length > EMBEDDINGS_WIRE_LIMITS.totalCharacters)
    ) {
      batches.push(current);
      current = [];
      characters = 0;
    }
    current.push(text);
    characters += text.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function hostWorkspaceEmbedder(
  api: DocBlocksHostEmbeddingsAPI,
  status: EmbeddingsStatus,
): WorkspaceIndexEmbedder {
  return {
    profileId: status.profileId,
    async embed(kind, texts, signal) {
      const vectors: Float32Array[] = [];
      for (const batch of embeddingBatches(texts)) {
        if (signal?.aborted) throw abortError();
        vectors.push(...(await api.embed({ kind, texts: batch })));
      }
      if (signal?.aborted) throw abortError();
      return vectors;
    },
    tokenizer: () => api.tokenizer(),
  };
}

export interface HostSemanticSearch {
  /** Present once the host's model is ready. */
  readonly embedder: WorkspaceIndexEmbedder | null;
  /** The host's last reported status; null before the first answer or without a host model. */
  readonly status: EmbeddingsStatus | null;
  /** Download the model, on a host that does not bundle it; absent otherwise. */
  readonly prepare: (() => void) | undefined;
}

const DOWNLOAD_POLL_MS = 1_000;
/** A model can arrive another way (a knowledge catalog brings the same one). */
const MISSING_POLL_MS = 15_000;

/**
 * The host's embedding model for semantic search: its status, a download
 * action where the host downloads the model, and an embedder once it is
 * ready. Stable while the host's profile stays the same.
 */
export function useHostSemanticSearch(enabled: boolean): HostSemanticSearch {
  const [embedder, setEmbedder] = useState<WorkspaceIndexEmbedder | null>(null);
  const [status, setStatus] = useState<EmbeddingsStatus | null>(null);
  const [check, setCheck] = useState(0);
  const api = enabled ? maybeGetDocBlocksHost()?.embeddings : undefined;

  useEffect(() => {
    if (!api) {
      setEmbedder(null);
      setStatus(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      void api.status().then(
        (next) => {
          if (cancelled) return;
          setStatus(next);
          setEmbedder((current) =>
            next.state !== 'ready'
              ? null
              : current?.profileId === next.profileId
                ? current
                : hostWorkspaceEmbedder(api, next),
          );
          clearTimeout(timer);
          if (next.state === 'downloading') timer = setTimeout(read, DOWNLOAD_POLL_MS);
          else if (next.state === 'download-required') timer = setTimeout(read, MISSING_POLL_MS);
        },
        () => {
          if (!cancelled) {
            setStatus(null);
            setEmbedder(null);
          }
        },
      );
    };
    read();
    // Coming back to the app re-reads it too.
    const onVisible = () => {
      if (document.visibilityState === 'visible') read();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', read);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', read);
    };
  }, [api, check]);

  const prepare = useMemo(() => {
    const download = api?.prepare?.bind(api);
    if (!download) return undefined;
    return () => {
      // Read progress at once; read again when it ends, however it ends.
      const done = download();
      setCheck((value) => value + 1);
      void done.finally(() => setCheck((value) => value + 1)).catch(() => undefined);
    };
  }, [api]);

  return useMemo(() => ({ embedder, status, prepare }), [embedder, status, prepare]);
}
