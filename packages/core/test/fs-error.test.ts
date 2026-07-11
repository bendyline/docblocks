import { expect } from 'chai';
import {
  FsError,
  fsErrorFromUnknown,
  isQuotaExceededError,
  serializeFsError,
} from '@bendyline/docblocks/filesystem';

describe('isQuotaExceededError', () => {
  it('detects typed FsError quota codes', () => {
    expect(isQuotaExceededError(new FsError('quota-exceeded', 'disk full'))).to.equal(true);
    expect(isQuotaExceededError(new FsError('io', 'something else'))).to.equal(false);
    expect(isQuotaExceededError(new FsError('permission-denied', 'nope'))).to.equal(false);
  });

  it('detects serialized FsError copies (IPC / postMessage round-trip)', () => {
    const serialized = serializeFsError(new FsError('quota-exceeded', 'disk full'));
    expect(isQuotaExceededError(serialized)).to.equal(true);
    expect(isQuotaExceededError(serializeFsError(new FsError('io', 'other')))).to.equal(false);
  });

  it('detects raw DOMException-shaped errors from unwrapped backends', () => {
    // The File System Access provider does not wrap errors; a quota failure
    // arrives as a plain DOMException whose instanceof may not even hold
    // across realms. Only the name is load-bearing.
    expect(isQuotaExceededError({ name: 'QuotaExceededError', message: 'quota hit' })).to.equal(
      true,
    );
    expect(isQuotaExceededError({ name: 'NotFoundError', message: 'missing' })).to.equal(false);
  });

  it('classifies platform errors routed through fsErrorFromUnknown', () => {
    expect(
      isQuotaExceededError(fsErrorFromUnknown({ code: 'ENOSPC', message: 'disk full' })),
    ).to.equal(true);
    expect(isQuotaExceededError(fsErrorFromUnknown({ code: 'EDQUOT', message: 'quota' }))).to.equal(
      true,
    );
    expect(
      isQuotaExceededError(fsErrorFromUnknown({ name: 'QuotaExceededError', message: 'q' })),
    ).to.equal(true);
    expect(
      isQuotaExceededError(fsErrorFromUnknown({ code: 'ENOENT', message: 'missing' })),
    ).to.equal(false);
  });

  it('rejects unrelated values', () => {
    expect(isQuotaExceededError(new Error('QuotaExceededError mentioned in message'))).to.equal(
      false,
    );
    expect(isQuotaExceededError(null)).to.equal(false);
    expect(isQuotaExceededError(undefined)).to.equal(false);
    expect(isQuotaExceededError('QuotaExceededError')).to.equal(false);
    expect(isQuotaExceededError(42)).to.equal(false);
  });
});
