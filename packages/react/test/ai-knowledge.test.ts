import { expect } from 'chai';
import type { AiChatKnowledge } from '@bendyline/docblocks/host';

import { AI_WIRE_LIMITS } from '@bendyline/docblocks/host';

import { factCheckRequest, factsNeedReview, mergeAiKnowledge } from '../src/Ai/ai-knowledge.js';

const used = (catalogId: string, ...titles: string[]): AiChatKnowledge => ({
  outcome: 'used',
  sources: [{ catalogId, name: catalogId.toUpperCase(), titles }],
  evidence: titles.map((title) => `${title} passage.`),
});

describe('mergeAiKnowledge', () => {
  it('lets any citation in a run outrank a later request that found nothing', () => {
    const first = used('pnw', 'Panama Hotel');
    expect(mergeAiKnowledge(first, { outcome: 'none' })).to.deep.equal(first);
    expect(mergeAiKnowledge({ outcome: 'skipped' }, first)).to.deep.equal(first);
  });

  it('prefers a search that found nothing over one that never ran', () => {
    expect(mergeAiKnowledge({ outcome: 'skipped' }, { outcome: 'none' })).to.deep.equal({
      outcome: 'none',
    });
    expect(mergeAiKnowledge({ outcome: 'none' }, { outcome: 'skipped' })).to.deep.equal({
      outcome: 'none',
    });
    expect(mergeAiKnowledge(null, { outcome: 'skipped' })).to.deep.equal({ outcome: 'skipped' });
  });

  it('unions catalogs and articles without duplicates or mutating either side', () => {
    const first = used('pnw', 'Panama Hotel');
    const merged = mergeAiKnowledge(first, {
      outcome: 'used',
      sources: [
        { catalogId: 'pnw', name: 'PNW', titles: ['Panama Hotel', 'Nihonmachi'] },
        { catalogId: 'law', name: 'LAW', titles: ['Statute'] },
      ],
      evidence: ['Panama Hotel passage.', 'Nihonmachi passage.', 'Statute passage.'],
    });
    expect(merged).to.deep.equal({
      outcome: 'used',
      sources: [
        { catalogId: 'pnw', name: 'PNW', titles: ['Panama Hotel', 'Nihonmachi'] },
        { catalogId: 'law', name: 'LAW', titles: ['Statute'] },
      ],
      evidence: ['Panama Hotel passage.', 'Nihonmachi passage.', 'Statute passage.'],
    });
    expect(first).to.deep.equal(used('pnw', 'Panama Hotel'));
  });
});

describe('fact check requests', () => {
  it('checks against every passage the run was shown, and nothing past the host bounds', () => {
    expect(factCheckRequest('Draft.', used('pnw', 'A', 'B'), 'Given.')).to.deep.equal({
      text: 'Draft.',
      evidence: ['A passage.', 'B passage.'],
      given: 'Given.',
    });
    expect(factCheckRequest('Draft.', { outcome: 'none' }, '')?.evidence).to.deep.equal([]);
    const big = 'x'.repeat(AI_WIRE_LIMITS.factCheckEvidenceCharacters - 10);
    const many: AiChatKnowledge = {
      outcome: 'used',
      sources: [{ catalogId: 'a', name: 'A', titles: [] }],
      evidence: [big, 'one too many'],
    };
    expect(factCheckRequest('Draft.', many, '')?.evidence).to.deep.equal([big]);
    expect(
      factCheckRequest('x'.repeat(AI_WIRE_LIMITS.factCheckTextCharacters + 1), null, ''),
    ).to.equal(null);
    expect(
      factCheckRequest('Draft.', null, 'g'.repeat(AI_WIRE_LIMITS.factCheckGivenCharacters + 5))
        ?.given.length,
    ).to.equal(AI_WIRE_LIMITS.factCheckGivenCharacters);
  });

  it("asks before inserting at Gezel's bar for refusing a write", () => {
    const sentence = (strong: boolean) => ({ text: 'S.', missing: ['X'], strong });
    expect(factsNeedReview({ checked: 4, unsourced: [] })).to.equal(false);
    expect(factsNeedReview({ checked: 4, unsourced: [sentence(true)] })).to.equal(true);
    // One or two sentences of unsourced names alone are too often a false alarm.
    expect(factsNeedReview({ checked: 4, unsourced: [sentence(false), sentence(false)] })).to.equal(
      false,
    );
    expect(
      factsNeedReview({
        checked: 4,
        unsourced: [sentence(false), sentence(false), sentence(false)],
      }),
    ).to.equal(true);
  });
});
