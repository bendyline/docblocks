import { expect } from 'chai';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { acquireWorkspaceWatcher } from '../main/workspace-watchers.js';

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for filesystem event');
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

describe('workspace watcher physical containment', () => {
  it('does not follow a symlink or junction into an external directory', async () => {
    const container = await fs.mkdtemp(path.join(os.tmpdir(), 'docblocks-watcher-links-'));
    const workspace = path.join(container, 'workspace');
    const outside = path.join(container, 'outside');
    await fs.mkdir(workspace);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'secret.md'), 'initial');
    await fs.symlink(
      outside,
      path.join(workspace, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const events: string[] = [];
    const watcher = acquireWorkspaceWatcher(workspace);
    const removeListener = watcher.onChange((itemPath) => events.push(itemPath));
    try {
      await watcher.ready;
      await fs.writeFile(path.join(outside, 'secret.md'), 'changed');
      await new Promise<void>((resolve) => setTimeout(resolve, 350));

      await fs.writeFile(path.join(workspace, 'inside.md'), 'inside');
      await waitFor(() => events.includes('/inside.md'));
      expect(events.some((itemPath) => itemPath.startsWith('/escape/'))).to.equal(false);
    } finally {
      removeListener();
      await watcher.dispose();
      await fs.rm(container, { recursive: true, force: true });
    }
  });
});
