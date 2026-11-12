import assert from 'node:assert/strict';
import type { ModelDescriptor } from '@bendyline/gezel-app-sdk/browser';
import { downloadChoices, modelChoices } from '../src/ai/models';

const fits = { tier: 'fits', label: 'fits in memory', detail: 'Runs comfortably.' } as const;

function download(id: string, extra: Record<string, unknown> = {}): ModelDescriptor {
  return {
    id,
    object: 'model',
    created: 0,
    owned_by: 'llama-cpp',
    name: id,
    availability: 'download-required',
    locality: 'on-device',
    preparation: 'app-download',
    download_bytes: 1_000_000,
    fit: fits,
    ...extra,
  } as unknown as ModelDescriptor;
}

describe('mobile model choices', () => {
  it('ranks downloads by Gezel’s docbench recommendation and carries the scores', () => {
    const choices = downloadChoices([
      download('catalog:small', {
        docbench: { score: 37.3, band: 8, version: '0.2.1', families: { review: 14 } },
        docbench_recommendation: { score: 83, recommended: false },
      }),
      download('catalog:plain'),
      download('catalog:best', {
        docbench: { score: 70.7, band: 3, version: '0.2.1', families: { review: 53 } },
        docbench_recommendation: { score: 100, recommended: true },
      }),
      download('catalog:custom', {
        docbench: { score: 55.2, band: 5, version: '0.2.1' },
      }),
    ]);
    assert.deepEqual(
      choices.map((choice) => choice.id),
      ['catalog:best', 'catalog:small', 'catalog:plain', 'catalog:custom'],
    );
    assert.deepEqual(choices[0], {
      id: 'catalog:best',
      label: 'catalog:best',
      contextWindow: null,
      downloadBytes: 1_000_000,
      state: 'download-required',
      fit: fits,
      score: 100,
      recommended: true,
      docbench: { score: 70.7, band: 3, version: '0.2.1', families: { review: 53 } },
    });
    // Measured but never recommended (not open-licensed): the score shows, no ranking.
    assert.deepEqual(choices[3]?.docbench, {
      score: 55.2,
      band: 5,
      version: '0.2.1',
      families: {},
    });
    assert.equal(choices[3]?.score, null);
    assert.equal(choices[2]?.docbench, undefined);
  });

  it('keeps an older Gezel’s list as it was: unrated, in its own order', () => {
    const choices = downloadChoices([download('b'), download('a')]);
    assert.deepEqual(
      choices.map((choice) => [choice.id, choice.score, choice.recommended, choice.docbench]),
      [
        ['b', null, false, undefined],
        ['a', null, false, undefined],
      ],
    );
  });

  it('shows an installed model’s docbench score in the picker', () => {
    const [installed] = modelChoices(
      [
        download('llama-cpp:writer', {
          availability: 'available',
          docbench: { score: 80.7, band: 1, version: '0.2.1', families: {} },
        }),
      ],
      null,
    );
    assert.equal(installed?.docbench?.score, 80.7);
  });
});
