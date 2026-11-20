/**
 * `host.embeddings` on the phone apps: Gezel's on-device text embedder over
 * the knowledge plugin's model store. The model is the one knowledge
 * catalogs search with, so a phone that installed it for knowledge has
 * nothing to download; otherwise Settings offers the download.
 *
 * Nothing native loads until semantic search first asks.
 */
import type { DocBlocksHostEmbeddingsAPI, EmbeddingsStatus } from '@bendyline/docblocks/host';

/**
 * Gezel's `MobileTextEmbedder`, declared here until DocBlocks pins the
 * gezel-capacitor release that exports it; replace with that type then.
 */
interface MobileTextEmbedder {
  readonly profileId: string;
  readonly dimensions: number;
  status(): Promise<{
    readonly state: 'ready' | 'download-required' | 'downloading' | 'unavailable';
    readonly receivedBytes: number;
    readonly totalBytes: number;
    readonly error: string | null;
  }>;
  install(): Promise<void>;
  embed(kind: 'passage' | 'query', texts: readonly string[]): Promise<Float32Array[]>;
  tokenizer(): Promise<{ definition: string; config: string }>;
}
type MobileTextEmbedderFactory = (options: { profileId: string }) => MobileTextEmbedder;

const PROFILE_ID = 'bge-small-en-v1.5@1';
const DIMENSIONS = 384;

type CapacitorModule = typeof import('@bendyline/gezel-capacitor');

export function installMobileEmbeddings(
  load: () => Promise<CapacitorModule> = () => import('@bendyline/gezel-capacitor'),
): DocBlocksHostEmbeddingsAPI {
  let embedder: Promise<MobileTextEmbedder | null> | null = null;
  const get = () => {
    embedder ??= load().then(
      (module) => {
        // gezel-capacitor 1.1.3 and earlier have no text embedder; semantic search stays off.
        const create = (module as { createMobileTextEmbedder?: MobileTextEmbedderFactory })
          .createMobileTextEmbedder;
        return create ? create({ profileId: PROFILE_ID }) : null;
      },
      () => {
        embedder = null;
        return null;
      },
    );
    return embedder;
  };
  const unavailable = (reason: string): EmbeddingsStatus => ({
    profileId: PROFILE_ID,
    dimensions: DIMENSIONS,
    state: 'unavailable',
    reason,
    download: null,
  });
  const ready = async () => {
    const current = await get();
    if (!current) throw new Error('Semantic search is not available in this version.');
    return current;
  };
  return {
    async status() {
      const current = await get();
      if (!current) return unavailable('Semantic search is not available in this version.');
      const status = await current.status();
      return {
        profileId: current.profileId,
        dimensions: current.dimensions,
        state: status.state,
        reason:
          status.state === 'unavailable'
            ? 'The search model could not be checked on this device.'
            : status.error,
        download: { receivedBytes: status.receivedBytes, totalBytes: status.totalBytes },
      };
    },
    async embed(request) {
      return (await ready()).embed(request.kind, request.texts);
    },
    async tokenizer() {
      try {
        return await (await ready()).tokenizer();
      } catch {
        return null;
      }
    },
    async prepare() {
      await (await ready()).install();
    },
  };
}
