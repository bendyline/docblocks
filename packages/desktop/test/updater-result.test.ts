import { expect } from 'chai';
import {
  classifyUpdateCheck,
  failedUpdateCheck,
  updaterStatusForError,
} from '../main/updater-result.js';

describe('desktop updater results', () => {
  it('distinguishes available and current versions', () => {
    expect(classifyUpdateCheck('1.0.0', '1.1.0')).to.deep.equal({
      kind: 'available',
      version: '1.1.0',
    });
    expect(classifyUpdateCheck('1.0.0', '1.0.0')).to.deep.equal({ kind: 'not-available' });
    expect(classifyUpdateCheck('1.0.0', null)).to.deep.equal({ kind: 'not-available' });
  });

  it('keeps bounded updater failures distinct from no-update results', () => {
    expect(failedUpdateCheck(new Error('offline'))).to.deep.equal({
      kind: 'error',
      message: 'offline',
    });
    const bounded = failedUpdateCheck('x'.repeat(10_000));
    expect(bounded.kind).to.equal('error');
    if (bounded.kind === 'error') expect(bounded.message.length).to.equal(2_000);
  });

  it('keeps unavailable update services quiet while surfacing download failures', () => {
    expect(updaterStatusForError('checking', new Error('offline'))).to.deep.equal({
      kind: 'not-available',
    });
    expect(
      updaterStatusForError('checking', new Error('Cannot find latest-mac.yml (404)')),
    ).to.deep.equal({ kind: 'not-available' });
    expect(updaterStatusForError('downloading', new Error('checksum mismatch'))).to.deep.equal({
      kind: 'error',
      message: 'checksum mismatch',
    });
  });
});
