import { expect } from 'chai';
import { parseAiKnowledgeAction, parseAiKnowledgeState } from '../src/host/ai-knowledge.js';

describe('AI knowledge wire policy', () => {
  const state = { catalogs: [], improvement: { downloadBytes: 24_000_000, downloading: false } };
  it('accepts the exact provider-neutral state', () => {
    expect(parseAiKnowledgeState(state)).to.deep.equal(state);
    expect(parseAiKnowledgeState({ ...state, improvement: null })).to.deep.equal({
      ...state,
      improvement: null,
    });
  });
  it('rejects unknown fields and malformed or unbounded state', () => {
    for (const value of [
      { ...state, path: 'C:/secret' },
      { ...state, improvement: { ...state.improvement, path: 'secret' } },
      { ...state, improvement: { ...state.improvement, downloadBytes: null } },
      { ...state, improvement: { ...state.improvement, downloadBytes: -1 } },
      { catalogs: [] },
      { ...state, catalogs: Array(513).fill(null) },
    ])
      expect(parseAiKnowledgeState(value)).to.equal(null);
  });
  it('accepts catalog actions but rejects extra authority', () => {
    expect(parseAiKnowledgeAction({ action: 'install', catalogId: 'science' })).to.deep.equal({
      action: 'install',
      catalogId: 'science',
    });
    expect(parseAiKnowledgeAction({ action: 'improve' })).to.deep.equal({ action: 'improve' });
    for (const value of [
      { action: 'install', catalogId: 'science', path: 'C:/secret' },
      { action: 'improve', model: 'untrusted' },
      { action: 'prepare-reranker' },
      { action: 'remove', catalogId: '\0' },
    ])
      expect(parseAiKnowledgeAction(value)).to.equal(null);
  });
});
