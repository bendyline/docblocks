import { expect } from 'chai';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ensurePersistedDefaultWorkspace } from '../main/default-workspace.js';

describe('persisted default workspace provisioning', () => {
  let testRoot: string;

  beforeEach(async () => {
    testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'docblocks-default-workspace-'));
  });

  afterEach(async () => {
    await fs.rm(testRoot, { recursive: true, force: true });
  });

  it('recreates a missing app-managed default workspace', async () => {
    const workspaceRoot = path.join(testRoot, 'Documents', 'DocBlocks');

    await ensurePersistedDefaultWorkspace(workspaceRoot, workspaceRoot);

    expect((await fs.stat(workspaceRoot)).isDirectory()).to.equal(true);
  });

  it('does not create a missing user-added workspace', async () => {
    const workspaceRoot = path.join(testRoot, 'removed-workspace');
    const defaultWorkspaceRoot = path.join(testRoot, 'Documents', 'DocBlocks');

    await ensurePersistedDefaultWorkspace(workspaceRoot, defaultWorkspaceRoot);

    let error: unknown;
    try {
      await fs.stat(workspaceRoot);
    } catch (caught: unknown) {
      error = caught;
    }
    expect((error as NodeJS.ErrnoException).code).to.equal('ENOENT');
  });
});
