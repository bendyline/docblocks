import { expect } from 'chai';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  grantExternalPath,
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
