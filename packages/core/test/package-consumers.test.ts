import { expect } from 'chai';
import { parsePackResult } from '../../../scripts/check-package-consumers.js';

describe('package consumer checks', () => {
  it('parses npm 12 keyed pack results', () => {
    expect(
      parsePackResult(
        JSON.stringify({
          '@bendyline/docblocks': { filename: 'bendyline-docblocks-2.5.0.tgz' },
        }),
        '@bendyline/docblocks',
      ),
    ).to.deep.equal({ filename: 'bendyline-docblocks-2.5.0.tgz' });
  });

  it('continues to parse legacy array pack results', () => {
    expect(
      parsePackResult(
        JSON.stringify([{ filename: 'bendyline-docblocks-2.5.0.tgz' }]),
        '@bendyline/docblocks',
      ),
    ).to.deep.equal({ filename: 'bendyline-docblocks-2.5.0.tgz' });
  });

  it('rejects mismatched and ambiguous keyed pack results', () => {
    expect(() =>
      parsePackResult(JSON.stringify({ other: { filename: 'other.tgz' } }), 'expected'),
    ).to.throw('npm pack reported unexpected package other');
    expect(() =>
      parsePackResult(
        JSON.stringify({
          first: { filename: 'first.tgz' },
          second: { filename: 'second.tgz' },
        }),
        'first',
      ),
    ).to.throw('npm pack returned an unexpected result count');
  });
});
