import { expect } from 'chai';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  grantExternalPath,
  resolveExternalRelativeMedia,
  resolveExternalResource,
  revokeExternalOwner,
  revokeExternalResource,
} from '../main/external-files.js';

describe('external file grants', () => {
  let directory = '';
  let file = '';

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'docblocks-external-grant-'));
    file = path.join(directory, 'document.md');
    await fs.writeFile(file, '# Document');
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('keeps absolute paths in main and binds exact access to one owner', async () => {
    const grant = grantExternalPath(1, file);

    expect(grant).to.match(/^external_[0-9a-f-]{36}$/);
    expect(grant).not.to.include('document.md');
    expect(await resolveExternalResource(1, grant)).to.equal(await fs.realpath(file));
    await expectRejected(resolveExternalResource(2, grant), 'another window');
  });

  it('supports exact and owner-wide revocation', async () => {
    const exact = grantExternalPath(3, file);
    revokeExternalResource(3, exact);
    await expectRejected(resolveExternalResource(3, exact), 'expired');

    const ownerWide = grantExternalPath(3, file);
    revokeExternalOwner(3);
    await expectRejected(resolveExternalResource(3, ownerWide), 'expired');
  });

  describe('relative media', () => {
    it('confines a loose document to media inside its own folder', async () => {
      const grant = grantExternalPath(4, file, { relativeMedia: true });
      const parent = await fs.realpath(directory);

      expect(await resolveExternalRelativeMedia(4, grant, 'shots/journey/j02.png')).to.equal(
        path.join(parent, 'shots', 'journey', 'j02.png'),
      );
      for (const relativePath of [
        '../outside.png',
        'shots/../../outside.png',
        './a.png',
        '/etc/a.png',
        'shots//a.png',
        'shots\\a.png',
        'C:/a.png',
        'notes.md',
        'id_ed25519',
        '',
      ]) {
        await expectRejected(
          resolveExternalRelativeMedia(4, grant, relativePath),
          'Invalid relative media path',
        );
      }
      await expectRejected(resolveExternalRelativeMedia(5, grant, 'a.png'), 'another window');
      revokeExternalOwner(4);
    });

    it('refuses a grant minted without relative media, such as a bundle', async () => {
      const grant = grantExternalPath(6, file);
      await expectRejected(
        resolveExternalRelativeMedia(6, grant, 'a.png'),
        'does not grant relative media',
      );
      revokeExternalOwner(6);
    });
  });
});

async function expectRejected(promise: Promise<unknown>, message: string): Promise<void> {
  try {
    await promise;
    expect.fail('Expected promise to reject');
  } catch (error: unknown) {
    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.include(message);
  }
}
