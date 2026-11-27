import { expect } from 'chai';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { acquireWorkspaceWatcher, isIgnoredWatchPath } from '../main/workspace-watchers.js';

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

describe('workspace watcher: folder settings', () => {
  it('ignores dot folders, except the one file that says what a folder is', () => {
    const watched = [
      '',
      'Notes/a.md',
      'Tasks/.docblocks',
      'Tasks/.docblocks/folder.json',
      '.docblocks',
      '.docblocks/folder.json',
      'A\\B\\.docblocks\\folder.json',
    ];
    const ignored = [
      '.git',
      '.git/HEAD',
      'node_modules/x/index.js',
      '.docblocks/workspace.json',
      'Tasks/.docblocks/media',
      'Tasks/.docblocks/media/a.png',
      'Tasks/.docblocks/folder.json/x',
      'Tasks/.docblocks/.docblocks/folder.json',
      '.git/.docblocks/folder.json',
      'Tasks/.hidden/.docblocks/folder.json',
    ];
    for (const relative of watched) expect(isIgnoredWatchPath(relative), relative).to.equal(false);
    for (const relative of ignored) expect(isIgnoredWatchPath(relative), relative).to.equal(true);
  });

  it('reports a settings file changing, and nothing else under a metadata folder', async function () {
    // Several real filesystem events in a row, each of which the OS may take a moment over.
    this.timeout(60_000);
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'docblocks-watcher-folders-'));
    await fs.mkdir(path.join(workspace, 'Tasks', '.docblocks', 'media'), { recursive: true });
    await fs.mkdir(path.join(workspace, '.git'));

    const events: string[] = [];
    const watcher = acquireWorkspaceWatcher(workspace);
    const removeListener = watcher.onEvent((event) => {
      events.push(`${event.type} ${event.kind} ${event.path}`);
    });
    const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    /**
     * Write `relative` until the watcher reports it. The OS begins delivering
     * events a moment after a watcher (or a newly watched folder) is set up,
     * so a write made in that gap is repeated rather than trusted to be seen.
     */
    const written = async (relative: string, text: string): Promise<void> => {
      const reported = () =>
        events.some((event) => /^(created|modified) file /.test(event) && event.endsWith(relative));
      for (let attempt = 0; attempt < 30 && !reported(); attempt += 1) {
        await fs.writeFile(path.join(workspace, relative), `${text}${' '.repeat(attempt)}`);
        for (let waited = 0; waited < 20 && !reported(); waited += 1) await pause(50);
      }
      if (!reported()) {
        throw new Error(`Never saw ${relative} change. Saw: ${events.join(' | ') || 'nothing'}`);
      }
    };
    try {
      await watcher.ready;
      await written('/probe.md', 'events are flowing');

      await fs.writeFile(path.join(workspace, 'Tasks', '.docblocks', 'media', 'a.png'), 'x');
      await fs.writeFile(path.join(workspace, 'Tasks', '.docblocks', 'other.json'), '{}');
      await fs.writeFile(path.join(workspace, '.git', 'HEAD'), 'ref');
      await written('/Tasks/.docblocks/folder.json', '{"version":1,"kind":"tasks"}');
      events.length = 0;
      await written('/Tasks/.docblocks/folder.json', '{"version":1,"kind":"journal"}');

      // A folder set up elsewhere arriving whole, as a sync client delivers it.
      await fs.mkdir(path.join(workspace, 'Journal', '.docblocks'), { recursive: true });
      await written('/Journal/.docblocks/folder.json', '{"version":1,"kind":"journal"}');
      await waitFor(() => events.includes('created directory /Journal'), 15_000);

      await fs.rm(path.join(workspace, 'Tasks', '.docblocks', 'folder.json'));
      await waitFor(() => events.includes('removed file /Tasks/.docblocks/folder.json'), 15_000);

      // Anything the ignored writes above were going to report has arrived by now.
      await fs.writeFile(path.join(workspace, 'Tasks', '.docblocks', 'media', 'b.png'), 'x');
      await fs.writeFile(path.join(workspace, 'Journal', '.docblocks', 'workspace.json'), '{}');
      await written('/last.md', 'sentinel');

      const underMetadata = events.filter((event) => event.includes('/.docblocks'));
      expect(underMetadata.length).to.be.greaterThan(0);
      expect(
        underMetadata.every(
          (event) =>
            event.endsWith(' file /Tasks/.docblocks/folder.json') ||
            event.endsWith(' file /Journal/.docblocks/folder.json'),
        ),
      ).to.equal(true, underMetadata.join(' | '));
      expect(events.some((event) => event.includes('/.git'))).to.equal(false);
    } finally {
      removeListener();
      await watcher.dispose();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});
