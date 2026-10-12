import { expect } from 'chai';

import {
  INTEL_MAC_FINAL_NOTICE,
  INTEL_MAC_FINAL_VERSION,
  isUnsupportedIntelMac,
} from '../main/intel-mac-final.js';

describe('Intel Mac end of support', () => {
  it('froze Intel Mac support at 2.7.1', () => {
    // Raising this rebuilds Intel Macs and repoints their update feed. Do it only
    // to replace their final build on purpose.
    expect(INTEL_MAC_FINAL_VERSION).to.equal('2.7.1');
  });

  it('stops updates only on a real Intel Mac', () => {
    expect(isUnsupportedIntelMac({ platform: 'darwin', arch: 'x64', translated: false })).to.equal(
      true,
    );
    // Rosetta: an x64 build on Apple silicon still updates, onto native arm64.
    expect(isUnsupportedIntelMac({ platform: 'darwin', arch: 'x64', translated: true })).to.equal(
      false,
    );
    expect(
      isUnsupportedIntelMac({ platform: 'darwin', arch: 'arm64', translated: false }),
    ).to.equal(false);
    expect(isUnsupportedIntelMac({ platform: 'win32', arch: 'x64', translated: false })).to.equal(
      false,
    );
    expect(isUnsupportedIntelMac({ platform: 'linux', arch: 'x64', translated: false })).to.equal(
      false,
    );
  });

  it('names the final version and why updates stopped', () => {
    expect(INTEL_MAC_FINAL_NOTICE.message).to.contain(INTEL_MAC_FINAL_VERSION);
    expect(INTEL_MAC_FINAL_NOTICE.detail).to.contain('Apple silicon');
  });
});
