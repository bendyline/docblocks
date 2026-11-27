import { expect } from 'chai';
import {
  knowledgeChatEvent,
  parseAiKnowledgeAction,
  parseAiKnowledgeState,
} from '../src/host/ai-knowledge.js';
import { parseAiChatEvent } from '../src/host/ai-wire-policy.js';

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

describe('the knowledge chat event', () => {
  it("carries each passage's citation so a workspace note can be opened", () => {
    const event = knowledgeChatEvent(
      'used',
      [
        {
          title: 'Aphid',
          catalogId: 'pnw',
          text: 'Sap-sucking.',
          uri: 'knowledge://pnw/wiki/aphid',
        },
        {
          title: 'Rose bed',
          catalogId: 'workspace',
          text: 'Aphids on new growth.',
          uri: 'knowledge://local/ws-1/garden/roses.md#line=3-9',
        },
        { title: 'Untraced', catalogId: 'pnw', text: 'No citation.', uri: 'https://x.test/a' },
      ],
      new Map([['workspace', 'This workspace']]),
      true,
    );
    expect(event).to.deep.include({ outcome: 'used' });
    const evidence = event?.outcome === 'used' ? event.evidence : [];
    expect(evidence.map((entry) => entry.uri)).to.deep.equal([
      'knowledge://pnw/wiki/aphid',
      'knowledge://local/ws-1/garden/roses.md#line=3-9',
      undefined,
    ]);
    expect(parseAiChatEvent({ kind: 'knowledge', knowledge: event })).to.deep.equal({
      kind: 'knowledge',
      knowledge: event,
    });
  });
});
