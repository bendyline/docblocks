/**
 * The preload half of `DocBlocksHostEmbeddingsAPI`.
 *
 * Every value from main is re-parsed with the shared embeddings wire policy
 * before it reaches the renderer. `ipc` is injected so the bridge can be
 * tested without Electron.
 */

import {
  parseEmbeddingsStatus,
  parseEmbeddingsTokenizer,
  parseEmbeddingsVectors,
} from '@bendyline/docblocks/host';
import type { DocBlocksHostEmbeddingsAPI, EmbeddingsStatus } from '@bendyline/docblocks/host';

export interface EmbeddingsIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

const UNREADABLE = 'DocBlocks received a semantic search response it could not read.';

export function createEmbeddingsApi(ipc: EmbeddingsIpc): DocBlocksHostEmbeddingsAPI {
  let known: EmbeddingsStatus | null = null;
  const status = async (): Promise<EmbeddingsStatus> => {
    const parsed = parseEmbeddingsStatus(await ipc.invoke('embeddings:status'));
    if (!parsed) throw new Error(UNREADABLE);
    known = parsed;
    return parsed;
  };
  return {
    status,
    async embed(request) {
      const dimensions = (known ?? (await status())).dimensions;
      const vectors = parseEmbeddingsVectors(
        await ipc.invoke('embeddings:embed', { kind: request.kind, texts: [...request.texts] }),
        request.texts.length,
        dimensions,
      );
      if (!vectors) throw new Error(UNREADABLE);
      return vectors;
    },
    async tokenizer() {
      return parseEmbeddingsTokenizer(await ipc.invoke('embeddings:tokenizer'));
    },
  };
}
