import { expect } from 'chai';

import { parseMobileStorageDecided, parseMobileStorageOutcome } from '../src/host/mobile-wire.js';

describe('mobile storage choice wire', () => {
  it('reads whether Android has settled where documents live', () => {
    expect(parseMobileStorageDecided({ decided: true })).to.equal(true);
    expect(parseMobileStorageDecided({ decided: false })).to.equal(false);
  });

  it('rejects a decision that is missing, mistyped, or carries extra fields', () => {
    expect(() => parseMobileStorageDecided({})).to.throw();
    expect(() => parseMobileStorageDecided({ decided: 'yes' })).to.throw();
    expect(() => parseMobileStorageDecided({ decided: true, folder: 'x' })).to.throw();
    expect(() => parseMobileStorageDecided(undefined)).to.throw();
  });

  it('reads every outcome the folder picker reports', () => {
    for (const outcome of ['chosen', 'device', 'cancelled', 'failed'] as const)
      expect(parseMobileStorageOutcome({ outcome })).to.equal(outcome);
  });

  it('rejects an unknown outcome, or none', () => {
    expect(() => parseMobileStorageOutcome({ outcome: 'settled' })).to.throw();
    expect(() => parseMobileStorageOutcome({})).to.throw();
    expect(() => parseMobileStorageOutcome(undefined)).to.throw();
    expect(() => parseMobileStorageOutcome({ outcome: 'chosen', id: 'x' })).to.throw();
  });
});
