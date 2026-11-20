import { expect } from 'chai';
import { installMobileEmbeddings } from '../src/embeddings.js';

type Load = Parameters<typeof installMobileEmbeddings>[0];

function fakeModule(state: 'ready' | 'download-required' = 'ready') {
  const calls: string[] = [];
  let current = state;
  const module = {
    createMobileTextEmbedder: ({ profileId }: { profileId: string }) => ({
      profileId,
      dimensions: 384,
      status: async () => ({ state: current, receivedBytes: 0, totalBytes: 100, error: null }),
      install: async () => {
        calls.push('install');
        current = 'ready';
      },
      embed: async (kind: string, texts: readonly string[]) => {
        calls.push(`${kind}:${texts.length}`);
        return texts.map(() => new Float32Array(384));
      },
      tokenizer: async () => ({ definition: '{}', config: '{}' }),
    }),
  };
  return { load: (async () => module) as unknown as Load, calls };
}

describe('mobile host embeddings', () => {
  it('reports the model and embeds through Gezel', async () => {
    const { load, calls } = fakeModule();
    const api = installMobileEmbeddings(load);
    expect(await api.status()).to.deep.equal({
      profileId: 'bge-small-en-v1.5@1',
      dimensions: 384,
      state: 'ready',
      reason: null,
      download: { receivedBytes: 0, totalBytes: 100 },
    });
    expect(await api.embed({ kind: 'passage', texts: ['a', 'b'] })).to.have.length(2);
    expect(await api.tokenizer()).to.deep.equal({ definition: '{}', config: '{}' });
    expect(calls).to.deep.equal(['passage:2']);
  });

  it('downloads the model on request', async () => {
    const { load, calls } = fakeModule('download-required');
    const api = installMobileEmbeddings(load);
    expect((await api.status()).state).to.equal('download-required');
    await api.prepare?.();
    expect(calls).to.deep.equal(['install']);
    expect((await api.status()).state).to.equal('ready');
  });

  it('is unavailable with a Gezel release that has no text embedder', async () => {
    const api = installMobileEmbeddings((async () => ({})) as unknown as Load);
    expect(await api.status()).to.include({ state: 'unavailable' });
    expect(await api.tokenizer()).to.equal(null);
    const error = await api
      .embed({ kind: 'query', texts: ['q'] })
      .catch((caught: unknown) => caught);
    expect((error as Error).message).to.contain('not available');
  });
});
