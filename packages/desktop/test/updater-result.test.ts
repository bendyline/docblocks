import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from 'chai';
import {
  classifyUpdateCheck,
  failedUpdateCheck,
  releaseUrlFor,
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

  it('builds release links against the tag scheme the release workflow publishes', () => {
    // The workflow is the source of truth for the tag scheme; assert against it
    // rather than a second hardcoded copy, so renaming the tag breaks this test.
    const workflow = readFileSync(
      fileURLToPath(new URL('../../../.github/workflows/desktop-release.yml', import.meta.url)),
      'utf8',
    );
    const prefix = /format\('([a-z-]+)\{0\}',\s*needs\.build-windows\.outputs\.version\)/.exec(
      workflow,
    )?.[1];
    expect(prefix, 'release workflow tag_name prefix').to.equal('desktop-v');

    expect(releaseUrlFor('2.3.3')).to.equal(
      `https://github.com/bendyline/docblocks/releases/tag/${prefix}2.3.3`,
    );
    // Regression: a plain `v<version>` tag has never existed in this repo, and
    // the banner's "What's new" button opened a 404 for every release that used it.
    expect(releaseUrlFor('2.3.3')).to.not.equal(
      'https://github.com/bendyline/docblocks/releases/tag/v2.3.3',
    );
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
