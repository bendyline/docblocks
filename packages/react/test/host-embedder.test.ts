import { expect } from 'chai';
import { EMBEDDINGS_WIRE_LIMITS, type EmbeddingsRequest } from '@bendyline/docblocks/host';
import type { EmbeddingsStatus } from '@bendyline/docblocks/host';
import {
  embeddingBatches,
  hostWorkspaceEmbedder,
  useHostSemanticSearch,
} from '../src/WorkspaceIndex/host-embedder.js';
import { act, renderHook } from './helpers/renderHook.js';

describe('host workspace embedder', () => {
  it('splits texts into requests the bridge accepts', () => {
    const many = Array.from({ length: EMBEDDINGS_WIRE_LIMITS.texts + 3 }, (_, n) => `t${n}`);
    expect(embeddingBatches(many).map((batch) => batch.length)).to.deep.equal([
      EMBEDDINGS_WIRE_LIMITS.texts,
      3,
    ]);
    const long = 'x'.repeat(EMBEDDINGS_WIRE_LIMITS.textCharacters + 50);
    const [[cut] = []] = embeddingBatches([long]);
    expect(cut).to.have.length(EMBEDDINGS_WIRE_LIMITS.textCharacters);
    const wide = Array.from({ length: 20 }, () =>
      'y'.repeat(EMBEDDINGS_WIRE_LIMITS.textCharacters),
    );
    for (const batch of embeddingBatches(wide)) {
      const characters = batch.reduce((sum, text) => sum + text.length, 0);
      expect(characters).to.be.at.most(EMBEDDINGS_WIRE_LIMITS.totalCharacters);
    }
    expect(embeddingBatches(['a\0b'])).to.deep.equal([['ab']]);
  });

  it('embeds across batches in order and stops when aborted', async () => {
    const requests: EmbeddingsRequest[] = [];
    let seen = 0;
    const embedder = hostWorkspaceEmbedder(
      {
        status: async () => ({
          profileId: 'p@1',
          dimensions: 1,
          state: 'ready',
          reason: null,
          download: null,
        }),
        embed: async (request) => {
          requests.push(request);
          return request.texts.map(() => new Float32Array([seen++]));
        },
        tokenizer: async () => ({ definition: '{}', config: '{}' }),
      },
      { profileId: 'p@1', dimensions: 1, state: 'ready', reason: null, download: null },
    );
    expect(embedder.profileId).to.equal('p@1');
    const texts = Array.from({ length: EMBEDDINGS_WIRE_LIMITS.texts + 1 }, (_, n) => `t${n}`);
    const vectors = await embedder.embed('passage', texts);
    expect(vectors.map((vector) => vector[0])).to.deep.equal(texts.map((_, n) => n));
    expect(requests.map((request) => request.kind)).to.deep.equal(['passage', 'passage']);

    const controller = new AbortController();
    controller.abort();
    const error = await embedder
      .embed('query', ['q'], controller.signal)
      .catch((caught: unknown) => caught);
    expect((error as Error).name).to.equal('AbortError');
    expect(await embedder.tokenizer?.()).to.deep.equal({ definition: '{}', config: '{}' });
  });

  describe('useHostSemanticSearch', () => {
    const globals = globalThis as { docBlocksHost?: unknown };
    afterEach(() => {
      delete globals.docBlocksHost;
    });

    it('notices a model that arrives another way, and downloads one on request', async () => {
      let state: EmbeddingsStatus['state'] = 'download-required';
      let prepared = 0;
      globals.docBlocksHost = {
        embeddings: {
          status: async (): Promise<EmbeddingsStatus> => ({
            profileId: 'bge-small-en-v1.5@1',
            dimensions: 384,
            state,
            reason: null,
            download: { receivedBytes: 0, totalBytes: 100 },
          }),
          embed: async () => [],
          tokenizer: async () => null,
          prepare: async () => {
            prepared += 1;
            state = 'ready';
          },
        },
      };
      const hook = await renderHook((enabled: boolean) => useHostSemanticSearch(enabled), true);
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
      expect(hook.result.current.status?.state).to.equal('download-required');
      expect(hook.result.current.embedder).to.equal(null);

      // Installed elsewhere (a knowledge catalog brought the model): focus re-reads it.
      state = 'ready';
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(hook.result.current.embedder?.profileId).to.equal('bge-small-en-v1.5@1');

      state = 'download-required';
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(hook.result.current.embedder).to.equal(null);
      await act(async () => {
        hook.result.current.prepare?.();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(prepared).to.equal(1);
      expect(hook.result.current.status?.state).to.equal('ready');
      expect(hook.result.current.embedder).to.not.equal(null);

      await hook.rerender(false);
      expect(hook.result.current.embedder).to.equal(null);
      await hook.unmount();
    });
  });
});
