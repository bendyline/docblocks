import { expect } from 'chai';
import {
  providerModelDocbench,
  providerModelRanking,
  sortModelDownloads,
} from '../src/host/ai-provider-models.js';

describe('reading Gezel model ratings', () => {
  it('prefers the docbench ranking, then the general one, then none', () => {
    const general = { score: 90, recommended: true };
    const docbench = { score: 70, recommended: false };
    expect(
      providerModelRanking({ recommendation: general, docbench_recommendation: docbench }),
    ).to.deep.equal(docbench);
    expect(providerModelRanking({ recommendation: general })).to.deep.equal(general);
    expect(providerModelRanking({})).to.deep.equal({ score: null, recommended: false });
    // A malformed score is dropped, never trusted.
    expect(
      providerModelRanking({ recommendation: { score: 'high', recommended: 1 } }),
    ).to.deep.equal({ score: null, recommended: false });
  });

  it('reads a bounded docbench result and drops a malformed one', () => {
    const docbench = { score: 70.7, band: 3, version: '0.2.1', families: { review: 53 } };
    expect(providerModelDocbench({ docbench })).to.deep.equal(docbench);
    expect(
      providerModelDocbench({ docbench: { score: 50, band: 1, version: '0.2.1' } }),
    ).to.deep.equal({ score: 50, band: 1, version: '0.2.1', families: {} });
    expect(providerModelDocbench({ docbench: { ...docbench, score: 140 } })).to.equal(undefined);
    expect(providerModelDocbench({ docbench: 'great' })).to.equal(undefined);
    expect(providerModelDocbench({})).to.equal(undefined);
  });

  it('orders downloads best match first and leaves unrated ones in provider order', () => {
    const models = [
      { id: 'b', score: null, recommended: false },
      { id: 'good', score: 80, recommended: false },
      { id: 'a', score: null, recommended: false },
      { id: 'best', score: 100, recommended: true },
    ];
    expect(sortModelDownloads(models).map((model) => model.id)).to.deep.equal([
      'best',
      'good',
      'b',
      'a',
    ]);
    expect(models[0]?.id).to.equal('b');
  });
});
