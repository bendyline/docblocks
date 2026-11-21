/**
 * `host.embeddings` on the phone apps: Gezel's on-device text embedder over
 * the knowledge plugin's model store. The model is the one knowledge
 * catalogs search with, so a phone that installed it for knowledge has
 * nothing to download; otherwise Settings offers the download.
 *
 * Nothing native loads until semantic search first asks.
 */
import type { DocBlocksHostEmbeddingsAPI, EmbeddingsStatus } from '@bendyline/docblocks/host';
import type { MobileTextEmbedder } from '@bendyline/gezel-capacitor';

const PROFILE_ID = 'bge-small-en-v1.5@1';
const DIMENSIONS = 384;
const UNAVAILABLE = 'Semantic search is not available on this device.';

type CapacitorModule = Pick<
  typeof import('@bendyline/gezel-capacitor'),
  'createMobileTextEmbedder'
>;

export function installMobileEmbeddings(
  load: () => Promise<CapacitorModule> = () => import('@bendyline/gezel-capacitor'),
): DocBlocksHostEmbeddingsAPI {
  let embedder: Promise<MobileTextEmbedder | null> | null = null;
  const get = () => {
    embedder ??= load().then(
      (module) => module.createMobileTextEmbedder({ profileId: PROFILE_ID }),
      () => {
        // The plugin failed to load; the next request tries again.
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
    if (!current) throw new Error(UNAVAILABLE);
    return current;
  };
  return {
    async status() {
      const current = await get();
      if (!current) return unavailable(UNAVAILABLE);
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
