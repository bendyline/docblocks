import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from 'chai';
import {
  classifyUpdateCheck,
  failedUpdateCheck,
  releaseUrlFor,
  updaterStatusForError,
  userFacingUpdaterErrorMessage,
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

  it('keeps human-readable updater failures distinct from no-update results', () => {
    expect(failedUpdateCheck(new Error('offline'))).to.deep.equal({
      kind: 'error',
      message:
        'DocBlocks couldn\u2019t reach the update server. Check your internet connection and try again.',
    });
    const bounded = failedUpdateCheck('x'.repeat(10_000));
    expect(bounded.kind).to.equal('error');
    if (bounded.kind === 'error') {
      expect(bounded.message).to.equal(
        'DocBlocks couldn\u2019t complete the update. Try again later.',
      );
      expect(bounded.message.length).to.be.at.most(2_000);
    }
  });

  it('translates transport failures into recovery-oriented descriptions', () => {
    expect(userFacingUpdaterErrorMessage(new Error('net::ERR_NAME_NOT_RESOLVED'))).to.equal(
      'DocBlocks couldn\u2019t reach the update server. Check your internet connection, VPN, or DNS settings, then try again.',
    );
    expect(
      userFacingUpdaterErrorMessage(
        Object.assign(new Error('request failed'), { code: 'EAI_AGAIN' }),
      ),
    ).to.equal(
      'DocBlocks couldn\u2019t reach the update server. Check your internet connection, VPN, or DNS settings, then try again.',
    );
    expect(userFacingUpdaterErrorMessage(new Error('net::ERR_PROXY_CONNECTION_FAILED'))).to.equal(
      'DocBlocks couldn\u2019t connect through your proxy or VPN. Check those settings and try again.',
    );
    expect(userFacingUpdaterErrorMessage(new Error('Request timed out'))).to.equal(
      'The update server took too long to respond. Check your internet connection and try again.',
    );
    expect(userFacingUpdaterErrorMessage(new Error('net::ERR_CERT_DATE_INVALID'))).to.equal(
      'DocBlocks couldn\u2019t establish a secure connection to the update server. Check your system clock, proxy, or network security settings, then try again.',
    );
  });

  it('does not expose integrity, storage, or release-service internals', () => {
    expect(userFacingUpdaterErrorMessage(new Error('sha512 checksum mismatch'))).to.equal(
      'The downloaded update couldn\u2019t be verified, so DocBlocks did not install it. Try again later.',
    );
    expect(
      userFacingUpdaterErrorMessage(
        Object.assign(new Error('/private/update.zip'), { code: 'ENOSPC' }),
      ),
    ).to.equal('DocBlocks needs more free disk space to download the update.');
    expect(
      userFacingUpdaterErrorMessage(
        Object.assign(new Error('https://github.com/example/private/latest.yml'), {
          code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
        }),
      ),
    ).to.equal('Update information is temporarily unavailable. Try again later.');
    expect(userFacingUpdaterErrorMessage(new Error('token=secret-internal-detail'))).to.equal(
      'DocBlocks couldn\u2019t complete the update. Try again later.',
    );
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
      message:
        'The downloaded update couldn\u2019t be verified, so DocBlocks did not install it. Try again later.',
    });
  });
});
