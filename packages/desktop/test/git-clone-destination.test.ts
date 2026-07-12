import { expect } from 'chai';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CloneDestination, CloneDestinationExistsError } from '../main/git/clone-destination.js';

async function captureFailure(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
    return null;
  } catch (error: unknown) {
    return error;
  }
}

describe('clone destination ownership', () => {
  let parentDir = '';

  beforeEach(async () => {
    parentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'docblocks-clone-target-'));
  });

  afterEach(async () => {
    await fs.rm(parentDir, { recursive: true, force: true });
  });

  it('rejects every pre-existing target kind, including an empty directory', async () => {
    const target = path.join(parentDir, 'repository');
    await fs.writeFile(target, 'user data');
    expect(await captureFailure(CloneDestination.create(parentDir, 'repository'))).to.be.instanceOf(
      CloneDestinationExistsError,
    );
    expect(await fs.readFile(target, 'utf8')).to.equal('user data');

    await fs.rm(target);
    await fs.mkdir(target);
    expect(await captureFailure(CloneDestination.create(parentDir, 'repository'))).to.be.instanceOf(
      CloneDestinationExistsError,
    );
    expect(await fs.readdir(target)).to.deep.equal([]);
  });

  it('cleanup removes only operation-owned staging after a failure or cancellation', async () => {
    const destination = await CloneDestination.create(parentDir, 'repository');
    await fs.mkdir(destination.stagingDir);
    await fs.writeFile(path.join(destination.stagingDir, 'partial.md'), 'partial clone');
    const concurrentFile = path.join(destination.targetDir, 'user-data.txt');
    await fs.writeFile(concurrentFile, 'pre-existing user data');

    await destination.cleanup();

    expect(await fs.readFile(concurrentFile, 'utf8')).to.equal('pre-existing user data');
    expect(await captureFailure(fs.stat(destination.stagingRoot))).to.be.instanceOf(Error);
  });

  it('publishes a completed checkout into the exclusive reservation', async () => {
    const destination = await CloneDestination.create(parentDir, 'repository');
    await fs.mkdir(destination.stagingDir);
    await fs.writeFile(path.join(destination.stagingDir, 'README.md'), 'complete');
    await fs.writeFile(path.join(destination.stagingRoot, 'operation.log'), 'owned residue');

    const published = await destination.promote();

    expect(published).to.equal(await fs.realpath(destination.targetDir));
    expect(await fs.readFile(path.join(destination.targetDir, 'README.md'), 'utf8')).to.equal(
      'complete',
    );
    expect(await captureFailure(fs.stat(destination.stagingRoot))).to.be.instanceOf(Error);
  });

  it('does not replace a target created while the clone is in progress', async () => {
    const destination = await CloneDestination.create(parentDir, 'repository', {
      beforePublish: async (targetDir) => {
        await fs.writeFile(path.join(targetDir, 'user-data.txt'), 'arrived concurrently');
      },
    });
    await fs.mkdir(destination.stagingDir);
    await fs.writeFile(path.join(destination.stagingDir, 'README.md'), 'complete');

    expect(await captureFailure(destination.promote())).to.be.instanceOf(
      CloneDestinationExistsError,
    );
    await destination.cleanup();

    expect(await fs.readFile(path.join(destination.targetDir, 'user-data.txt'), 'utf8')).to.equal(
      'arrived concurrently',
    );
  });
});
