import { expect } from 'chai';

import {
  AI_SUGGESTION_MIN_BYTES,
  aiDeviceFit,
  parseAiDeviceFit,
  suggestsLocalAi,
} from '../src/host/index.js';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

describe('AI device fit', () => {
  it('suggests AI on a 16 GB Apple-silicon Mac, not an 8 GB one', () => {
    expect(suggestsLocalAi('unified', 16 * GIB)).to.equal(true);
    expect(suggestsLocalAi('unified', 8 * GIB)).to.equal(false);
  });

  it('suggests AI on an 8 GB graphics card as it reports itself, not a 6 GB one', () => {
    // nvidia-smi reports an 8 GB card a little under 8 GiB.
    expect(suggestsLocalAi('gpu', 8 * GIB - 200 * MIB)).to.equal(true);
    expect(suggestsLocalAi('gpu', 6 * GIB)).to.equal(false);
  });

  it('suggests AI on a 12 GB phone, not an 8 GB one', () => {
    expect(suggestsLocalAi('mobile', 11.2 * GIB)).to.equal(true);
    expect(suggestsLocalAi('mobile', 8 * GIB)).to.equal(false);
  });

  it('never suggests AI on system memory alone, or on memory it could not measure', () => {
    expect(AI_SUGGESTION_MIN_BYTES.system).to.equal(null);
    expect(suggestsLocalAi('system', 128 * GIB)).to.equal(false);
    expect(suggestsLocalAi('unified', null)).to.equal(false);
    expect(suggestsLocalAi('gpu', Number.NaN)).to.equal(false);
  });

  it('carries the verdict with the measurement', () => {
    expect(aiDeviceFit('unified', 24 * GIB)).to.deep.equal({
      memory: 'unified',
      bytes: 24 * GIB,
      suggestAi: true,
    });
  });

  it('works the verdict out again from the wire rather than trusting it', () => {
    expect(parseAiDeviceFit({ memory: 'gpu', bytes: 4 * GIB, suggestAi: true })).to.deep.equal({
      memory: 'gpu',
      bytes: 4 * GIB,
      suggestAi: false,
    });
    expect(parseAiDeviceFit({ memory: 'mobile', bytes: null })).to.deep.equal({
      memory: 'mobile',
      bytes: null,
      suggestAi: false,
    });
  });

  it('rejects anything that is not a device fit', () => {
    for (const value of [
      null,
      'unified',
      {},
      { memory: 'tpu', bytes: 16 * GIB },
      { memory: 'gpu', bytes: -1 },
      { memory: 'gpu', bytes: Number.POSITIVE_INFINITY },
      { memory: 'gpu', bytes: '8' },
      { memory: 'gpu' },
    ]) {
      expect(parseAiDeviceFit(value), JSON.stringify(value)).to.equal(null);
    }
  });
});
