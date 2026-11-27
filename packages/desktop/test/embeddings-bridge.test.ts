import { expect } from 'chai';
import { createEmbeddingsApi } from '../preload/embeddings-bridge.js';

const READY = {
  profileId: 'bge-small-en-v1.5@1',
  dimensions: 2,
  state: 'ready',
  reason: null,
  download: null,
};

function ipc(replies: Record<string, unknown>) {
  const calls: Array<{ channel: string; args: unknown[] }> = [];
  return {
    calls,
    invoke: async (channel: string, ...args: unknown[]) => {
      calls.push({ channel, args });
      return replies[channel];
    },
  };
}

describe('embeddings preload bridge', () => {
  it('re-parses status, vectors and tokenizer from main', async () => {
    const fake = ipc({
      'embeddings:status': READY,
      'embeddings:embed': [new Float32Array([1, 0]), new Float32Array([0, 1])],
      'embeddings:tokenizer': { definition: '{}', config: '{}' },
    });
    const api = createEmbeddingsApi(fake);
    expect(await api.status()).to.deep.equal(READY);
    const vectors = await api.embed({ kind: 'passage', texts: ['a', 'b'] });
    expect(vectors.map((vector) => Array.from(vector))).to.deep.equal([
      [1, 0],
      [0, 1],
    ]);
    expect(fake.calls[1]).to.deep.equal({
      channel: 'embeddings:embed',
      args: [{ kind: 'passage', texts: ['a', 'b'] }],
    });
    expect(await api.tokenizer()).to.deep.equal({ definition: '{}', config: '{}' });
  });

  it('refuses vectors of the wrong count or width', async () => {
    const api = createEmbeddingsApi(
      ipc({ 'embeddings:status': READY, 'embeddings:embed': [new Float32Array([1, 0, 0])] }),
    );
    const error = await api
      .embed({ kind: 'query', texts: ['a'] })
      .catch((caught: unknown) => caught);
    expect((error as Error).message).to.contain('could not read');
  });

  it('reads an unreadable tokenizer as none', async () => {
    const api = createEmbeddingsApi(ipc({ 'embeddings:tokenizer': { definition: 1 } }));
    expect(await api.tokenizer()).to.equal(null);
  });
});
