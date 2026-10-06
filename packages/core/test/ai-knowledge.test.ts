import { expect } from 'chai';
import { parseAiKnowledgeAction, parseAiKnowledgeState } from '../src/host/ai-knowledge.js';

describe('AI knowledge wire policy', () => {
  const state = { catalogs: [], reranker: { ready: false, downloading: false, message: null } };
  it('accepts the exact provider-neutral state', () => {
    expect(parseAiKnowledgeState(state)).to.deep.equal(state);
  });
  it('rejects unknown fields and malformed or unbounded state', () => {
    for (const value of [
      { ...state, path: 'C:/secret' },
      { ...state, reranker: { ...state.reranker, path: 'secret' } },
      { ...state, catalogs: Array(513).fill(null) },
      { ...state, reranker: { ...state.reranker, message: '\0' } },
    ])
      expect(parseAiKnowledgeState(value)).to.equal(null);
  });
  it('accepts catalog actions but rejects extra authority', () => {
    expect(parseAiKnowledgeAction({ action: 'install', catalogId: 'science' })).to.deep.equal({
      action: 'install',
      catalogId: 'science',
    });
    expect(parseAiKnowledgeAction({ action: 'prepare-reranker' })).to.deep.equal({
      action: 'prepare-reranker',
    });
    for (const value of [
      { action: 'install', catalogId: 'science', path: 'C:/secret' },
      { action: 'prepare-reranker', model: 'untrusted' },
      { action: 'remove', catalogId: '\0' },
    ])
      expect(parseAiKnowledgeAction(value)).to.equal(null);
  });
});
