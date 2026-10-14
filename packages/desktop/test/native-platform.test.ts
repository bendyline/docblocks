import { expect } from 'chai';
import { bundledNativeUnavailableReason } from '../main/native-platform.js';

describe('native feature OS support', () => {
  for (const macOS of ['12.0', '12.7.6', '13.0', '13.2.9', '', 'unknown']) {
    it(`blocks native AI/dictation on macOS ${macOS || '(unknown)'}`, () => {
      expect(bundledNativeUnavailableReason('darwin', { macOS })).to.contain('macOS 13.3');
    });
  }
  for (const macOS of ['13.3', '13.3.0', '13.3.1', '13.10', '14.0', '26.0']) {
    it(`accepts the native ABI on macOS ${macOS}`, () => {
      expect(bundledNativeUnavailableReason('darwin', { macOS })).to.equal(undefined);
    });
  }
  for (const glibc of ['2.9', '2.28', '2.35', '2.36', '2.37', '', 'musl']) {
    it(`blocks native AI/dictation with glibc ${glibc || '(unknown)'}`, () => {
      expect(bundledNativeUnavailableReason('linux', { glibc })).to.contain('glibc 2.38');
    });
  }
  for (const glibc of ['2.38', '2.38.0', '2.39', '2.43']) {
    it(`accepts the native ABI with glibc ${glibc}`, () => {
      expect(bundledNativeUnavailableReason('linux', { glibc })).to.equal(undefined);
    });
  }
  it('fails closed when Unix version metadata is unavailable, without changing Windows', () => {
    expect(bundledNativeUnavailableReason('darwin', {})).to.contain('macOS 13.3');
    expect(bundledNativeUnavailableReason('linux', {})).to.contain('glibc 2.38');
    expect(bundledNativeUnavailableReason('win32', {})).to.equal(undefined);
  });
});
