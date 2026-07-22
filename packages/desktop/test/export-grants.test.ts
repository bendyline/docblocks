import { expect } from 'chai';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  consumeExportPickerApproval,
  mintExportGrant,
  resolveExportGrant,
} from '../main/export-grants.js';

describe('desktop export grants', () => {
  let directory = '';

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'docblocks-export-grant-'));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('binds an exact target to one owner and document', async () => {
    const target = path.join(directory, 'report.pdf');
    const physicalTarget = path.join(await fs.realpath(directory), 'report.pdf');
    const grant = await mintExportGrant(10, 'document-a', target);

    expect(grant.displayPath).to.equal(physicalTarget);
    expect(grant.grantId).not.to.include(target);
    expect(await resolveExportGrant(10, 'document-a', grant.grantId)).to.deep.equal({
      absolutePath: physicalTarget,
      bookmark: undefined,
    });
    await expectRejected(resolveExportGrant(11, 'document-a', grant.grantId), 'another window');
    await expectRejected(resolveExportGrant(10, 'document-b', grant.grantId), 'another document');
  });

  it('rejects a target replaced by a symbolic link', async function () {
    const target = path.join(directory, 'report.pdf');
    const outside = path.join(directory, 'outside.pdf');
    await fs.writeFile(target, 'inside');
    await fs.writeFile(outside, 'outside');
    const grant = await mintExportGrant(20, 'document-a', target);
    await fs.rm(target);
    try {
      await fs.symlink(outside, target, 'file');
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') this.skip();
      throw error;
    }

    await expectRejected(resolveExportGrant(20, 'document-a', grant.grantId), 'regular file');
  });

  it('consumes native picker replacement approval after one save attempt', async () => {
    const target = path.join(directory, 'report.pdf');
    await fs.writeFile(target, 'existing');
    const grant = await mintExportGrant(30, 'document-a', target, undefined, 'file-identity');

    expect(consumeExportPickerApproval(30, grant.grantId)).to.equal('file-identity');
    expect(consumeExportPickerApproval(30, grant.grantId)).to.equal(null);
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
