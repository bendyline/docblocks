import { expect } from 'chai';
import {
  EMBEDDINGS_WIRE_LIMITS,
  parseEmbeddingsRequest,
  parseEmbeddingsStatus,
  parseEmbeddingsTokenizer,
  parseEmbeddingsVectors,
} from '../src/host/embeddings.js';

describe('embeddings wire policy', () => {
  it('accepts bounded passage and query requests and nothing else', () => {
    expect(parseEmbeddingsRequest({ kind: 'query', texts: ['heron'] })).to.deep.equal({
      kind: 'query',
      texts: ['heron'],
    });
    expect(parseEmbeddingsRequest({ kind: 'passage', texts: ['a', 'b'] })?.texts).to.have.length(2);
    for (const bad of [
      null,
      { kind: 'other', texts: ['x'] },
      { kind: 'query', texts: [] },
      { kind: 'query', texts: [1] },
      { kind: 'query', texts: ['x\0y'] },
      { kind: 'query', texts: ['x'], extra: true },
      { kind: 'query', texts: Array(EMBEDDINGS_WIRE_LIMITS.texts + 1).fill('x') },
      { kind: 'query', texts: ['x'.repeat(EMBEDDINGS_WIRE_LIMITS.textCharacters + 1)] },
      {
        kind: 'passage',
        texts: Array(EMBEDDINGS_WIRE_LIMITS.texts).fill(
          'x'.repeat(EMBEDDINGS_WIRE_LIMITS.textCharacters),
        ),
      },
    ]) {
      expect(parseEmbeddingsRequest(bad), JSON.stringify(bad)?.slice(0, 80)).to.equal(null);
    }
  });

  it('parses status exactly', () => {
    const ready = {
      profileId: 'bge-small-en-v1.5@1',
      dimensions: 384,
      state: 'ready',
      reason: null,
      download: null,
    };
    expect(parseEmbeddingsStatus(ready)).to.deep.equal(ready);
    expect(
      parseEmbeddingsStatus({ ...ready, state: 'unavailable', reason: 'Not in this build.' }),
    ).to.include({ state: 'unavailable' });
    expect(parseEmbeddingsStatus({ ...ready, profileId: 'no version' })).to.equal(null);
    expect(parseEmbeddingsStatus({ ...ready, dimensions: 0 })).to.equal(null);
    expect(parseEmbeddingsStatus({ ...ready, extra: 1 })).to.equal(null);
    const downloading = {
      ...ready,
      state: 'downloading',
      download: { receivedBytes: 10, totalBytes: 100 },
    };
    expect(parseEmbeddingsStatus(downloading)).to.deep.equal(downloading);
    expect(parseEmbeddingsStatus({ ...ready, state: 'later' })).to.equal(null);
    expect(
      parseEmbeddingsStatus({ ...ready, download: { receivedBytes: -1, totalBytes: 1 } }),
    ).to.equal(null);
  });

  it('requires one finite vector of the right width per text', () => {
    const vectors = parseEmbeddingsVectors([new Float32Array([1, 0]), [0, 1]], 2, 2);
    expect(vectors?.map((vector) => Array.from(vector))).to.deep.equal([
      [1, 0],
      [0, 1],
    ]);
    expect(parseEmbeddingsVectors([new Float32Array([1, 0])], 2, 2)).to.equal(null);
    expect(parseEmbeddingsVectors([new Float32Array([1])], 1, 2)).to.equal(null);
    expect(parseEmbeddingsVectors([new Float32Array([1, Number.NaN])], 1, 2)).to.equal(null);
    expect(parseEmbeddingsVectors([['1', 0]], 1, 2)).to.equal(null);
  });

  it('parses tokenizer files', () => {
    expect(parseEmbeddingsTokenizer({ definition: '{}', config: '{}' })).to.deep.equal({
      definition: '{}',
      config: '{}',
    });
    expect(parseEmbeddingsTokenizer({ definition: '{}' })).to.equal(null);
    expect(parseEmbeddingsTokenizer({ definition: 1, config: '{}' })).to.equal(null);
  });
});
