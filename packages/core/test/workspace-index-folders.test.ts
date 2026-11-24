import { expect } from 'chai';
import { FsError } from '../src/filesystem/fs-error.js';
import { MemoryFileSystemProviderV2 } from '../src/filesystem/memory-provider-v2.js';
import type { FileSystemEntrySnapshot } from '../src/filesystem/v2.js';
import {
  isEnumeratedWorkspaceEntryName,
  isIgnoredWorkspaceEntryName,
} from '../src/filesystem/workspace-entry-rules.js';
import { parseWorkspacePath, type WorkspacePath } from '../src/filesystem/workspace-path.js';
import { folderSettingsPath } from '../src/folders/index.js';
import {
  createWorkspaceIndex,
  type WorkspaceIndex,
  type WorkspaceIndexOptions,
  type WorkspaceIndexSource,
} from '../src/workspace-index/index.js';

const encode = (text: string) => new TextEncoder().encode(text);
const p = (path: string): WorkspacePath => parseWorkspacePath(path);
let sequence = 0;

const TASKS = '{"version":1,"kind":"tasks"}';
const JOURNAL = '{"version":1,"kind":"journal"}';

async function seed(files: Record<string, string>): Promise<MemoryFileSystemProviderV2> {
  const provider = new MemoryFileSystemProviderV2(`folders-${++sequence}`, 'Folders test');
  for (const [path, text] of Object.entries(files)) {
    await provider.writeFile(p(path), encode(text), { createParents: true });
  }
  return provider;
}

interface Probe {
  readonly source: WorkspaceIndexSource;
  readonly reads: string[];
  readonly lists: string[];
  /** Paths whose read fails with something other than "not there". */
  readonly broken: Set<string>;
}

/** Folder-by-folder listing over the memory provider, without change events. */
function walking(provider: MemoryFileSystemProviderV2): Probe {
  const reads: string[] = [];
  const lists: string[] = [];
  const broken = new Set<string>();
  const source: WorkspaceIndexSource = {
    capabilities: { watch: false },
    stat: (path) => provider.stat(path),
    readFile: (path) => {
      reads.push(path);
      if (broken.has(path)) {
        return Promise.reject(new FsError('io-error', 'The disk is not answering.', { path }));
      }
      return provider.readFile(path);
    },
    readDirectory: (path) => {
      lists.push(path);
      return provider.readDirectory(path);
    },
  };
  return { source, reads, lists, broken };
}

/**
 * The same, through a recursive listing that follows the `enumerate`
 * contract: ignored names are left out, except the metadata folder, which is
 * listed and not entered.
 */
function enumerating(provider: MemoryFileSystemProviderV2): Probe {
  const probe = walking(provider);
  const source: WorkspaceIndexSource = {
    ...probe.source,
    async *enumerate(root) {
      const queue: WorkspacePath[] = [root];
      while (queue.length > 0) {
        const entries: FileSystemEntrySnapshot[] = [];
        for (const child of await provider.readDirectory(queue.shift()!)) {
          if (!isEnumeratedWorkspaceEntryName(child.name)) continue;
          entries.push(child);
          if (
            child.kind === 'directory' &&
            !child.name.endsWith('_files') &&
            !isIgnoredWorkspaceEntryName(child.name)
          ) {
            queue.push(child.path);
          }
        }
        yield { entries, unreadable: [] };
      }
    },
  };
  return { ...probe, source };
}

function createIndex(
  source: WorkspaceIndexSource,
  overrides: Partial<WorkspaceIndexOptions> = {},
): WorkspaceIndex {
  let clock = 0;
  return createWorkspaceIndex({
    workspaceId: 'test',
    source,
    yieldControl: () => Promise.resolve(),
    now: () => (clock += 1),
    changeCoalesceMs: 0,
    minRefreshIntervalMs: 0,
    ...overrides,
  });
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

const settled = (index: WorkspaceIndex) => () => index.getStatus().phase === 'ready';
const kinds = (index: WorkspaceIndex) =>
  index
    .getFolderMarkers()
    .map((marker) => `${marker.path}:${marker.settings?.kind ?? marker.status}`);

describe('workspace entry rules: the metadata folder', () => {
  it('is the one ignored name a recursive listing reports', () => {
    expect(isIgnoredWorkspaceEntryName('.docblocks')).to.equal(true);
    expect(isEnumeratedWorkspaceEntryName('.docblocks')).to.equal(true);
    for (const name of ['.git', '.DS_Store', '.docblocks2', 'node_modules']) {
      expect(isEnumeratedWorkspaceEntryName(name), name).to.equal(false);
    }
    expect(isEnumeratedWorkspaceEntryName('Notes')).to.equal(true);
  });
});

for (const [label, probeOf] of [
  ['a folder-by-folder listing', walking],
  ['a recursive listing', enumerating],
] as const) {
  describe(`workspace index: folder settings, over ${label}`, () => {
    const files = {
      'Tasks/.docblocks/folder.json': TASKS,
      'Tasks/Active/Paint.md': '# Paint\n',
      'Tasks/Log/.docblocks/folder.json': JOURNAL,
      'Tasks/Log/2026/2026-11-23.md': '# Monday\n',
      'Notes/a.md': '# A\n',
      // A workspace's own settings: a `.docblocks` folder with no folder.json.
      '.docblocks/workspace.json': '{"version":1}',
      // Never looked into: other dot folders and anything else under `.docblocks`.
      '.git/.docblocks/folder.json': TASKS,
      'Notes/.docblocks/media/.docblocks/folder.json': TASKS,
    };

    it('finds the folders that say what they are, reading only their settings files', async () => {
      const provider = await seed(files);
      const probe = probeOf(provider);
      const index = createIndex(probe.source);
      index.start();
      try {
        await waitFor(settled(index), 'ready');
        expect(kinds(index)).to.deep.equal(['Tasks:tasks', 'Tasks/Log:journal']);
        const markerReads = probe.reads.filter((path) => path.includes('.docblocks'));
        expect(markerReads.sort()).to.deep.equal([
          '.docblocks/folder.json',
          'Notes/.docblocks/folder.json',
          'Tasks/.docblocks/folder.json',
          'Tasks/Log/.docblocks/folder.json',
        ]);
        // Nothing under a metadata folder is listed, indexed, or walked.
        expect(probe.lists.filter((path) => path.includes('.docblocks'))).to.deep.equal([]);
        expect(index.getFiles().some((file) => file.path.includes('.docblocks'))).to.equal(false);
        expect(index.getDirectories().some((path) => path.includes('.docblocks'))).to.equal(false);
        const marker = index.getFolderMarkers()[0]!;
        expect(marker).to.include({ path: 'Tasks', status: 'ok' });
        expect(marker.version).to.equal(
          (await provider.stat(folderSettingsPath(p('Tasks'))))?.version,
        );
      } finally {
        index.dispose();
        await provider.dispose();
      }
    });

    it('follows settings added, changed and removed when told the path changed', async () => {
      const provider = await seed(files);
      const index = createIndex(probeOf(provider).source);
      index.start();
      try {
        await waitFor(settled(index), 'ready');
        const generation = index.getStatus().generation;

        await provider.writeFile(folderSettingsPath(p('Notes')), encode(JOURNAL), {
          createParents: true,
        });
        index.invalidate('Notes/.docblocks/folder.json');
        await waitFor(() => kinds(index).includes('Notes:journal'), 'the new journal');
        expect(index.getStatus().generation).to.be.greaterThan(generation);

        await provider.writeFile(folderSettingsPath(p('Notes')), encode(TASKS));
        index.invalidate('Notes/.docblocks/folder.json');
        await waitFor(() => kinds(index).includes('Notes:tasks'), 'the changed kind');

        await provider.remove(folderSettingsPath(p('Notes')));
        index.invalidate('Notes/.docblocks/folder.json');
        await waitFor(() => !kinds(index).some((kind) => kind.startsWith('Notes:')), 'removal');

        // A whole metadata folder arriving (a sync client restoring it) counts too.
        await provider.writeFile(folderSettingsPath(p('Notes')), encode(JOURNAL), {
          createParents: true,
        });
        index.invalidate('Notes/.docblocks');
        await waitFor(() => kinds(index).includes('Notes:journal'), 'the restored journal');
      } finally {
        index.dispose();
        await provider.dispose();
      }
    });

    it("keeps a folder's settings in view while the folder is listed again", async () => {
      const provider = await seed(files);
      const index = createIndex(probeOf(provider).source);
      index.start();
      try {
        await waitFor(settled(index), 'ready');
        await provider.writeFile(p('Tasks/Active/new.md'), encode('# New\n'));
        const seen: string[][] = [];
        const record = () => seen.push(kinds(index));
        const unsubscribe = index.subscribe(record);
        index.invalidate('Tasks');
        // Ask on every turn of the loop while the change is applied, not only when it publishes.
        for (
          let turn = 0;
          turn < 200 && index.getDocument('Tasks/Active/new.md') === null;
          turn += 1
        ) {
          record();
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        unsubscribe();
        expect(index.getDocument('Tasks/Active/new.md')).to.not.equal(null);
        expect(seen.every((list) => list.includes('Tasks:tasks'))).to.equal(
          true,
          JSON.stringify(seen),
        );
      } finally {
        index.dispose();
        await provider.dispose();
      }
    });

    it("forgets a folder's settings when the folder goes, and finds them where it moved", async () => {
      const provider = await seed(files);
      const index = createIndex(probeOf(provider).source);
      index.start();
      try {
        await waitFor(settled(index), 'ready');
        await provider.move(p('Tasks'), p('Archive/Old tasks'), { createParents: true });
        index.refresh({ force: true });
        await waitFor(() => kinds(index).includes('Archive/Old tasks:tasks'), 'the moved folder');
        expect(kinds(index)).to.deep.equal([
          'Archive/Old tasks:tasks',
          'Archive/Old tasks/Log:journal',
        ]);
      } finally {
        index.dispose();
        await provider.dispose();
      }
    });

    it('reports settings it cannot use, and keeps the last ones it read when a read fails', async () => {
      const provider = await seed({
        ...files,
        'Newer/.docblocks/folder.json': '{"version":9,"kind":"tasks"}',
        'Odd/.docblocks/folder.json': '{"version":1,"kind":"chats"}',
        'Broken/.docblocks/folder.json': '{not json',
        'Newer/a.md': '# A\n',
        'Odd/a.md': '# A\n',
        'Broken/a.md': '# A\n',
      });
      const probe = probeOf(provider);
      const index = createIndex(probe.source);
      index.start();
      try {
        await waitFor(settled(index), 'ready');
        expect(kinds(index)).to.deep.equal([
          'Broken:invalid',
          'Newer:unsupported-version',
          'Odd:unsupported-kind',
          'Tasks:tasks',
          'Tasks/Log:journal',
        ]);

        probe.broken.add('Tasks/.docblocks/folder.json');
        index.refresh({ force: true });
        await waitFor(
          () => index.getFolderMarkers().some((marker) => marker.status === 'unreadable'),
          'the failed read',
        );
        const tasks = index.getFolderMarkers().find((marker) => marker.path === 'Tasks');
        // Still a tasks folder: a failed read is not evidence the settings are gone.
        expect(tasks).to.deep.include({
          status: 'unreadable',
          settings: { version: 1, kind: 'tasks' },
        });

        probe.broken.clear();
        index.refresh({ force: true });
        await waitFor(
          () => index.getFolderMarkers().find((marker) => marker.path === 'Tasks')?.status === 'ok',
          'recovery',
        );
      } finally {
        index.dispose();
        await provider.dispose();
      }
    });

    it('stops at its limit and says so, rather than passing folders over silently', async () => {
      const many: Record<string, string> = {};
      for (let n = 0; n < 6; n += 1) many[`F${n}/.docblocks/folder.json`] = TASKS;
      const provider = await seed(many);
      const index = createIndex(probeOf(provider).source, { limits: { maxFolderMarkers: 4 } });
      index.start();
      try {
        await waitFor(settled(index), 'ready');
        expect(index.getFolderMarkers()).to.have.length(4);
        expect(index.getStatus().truncated).to.deep.equal({ reason: 'folder-markers', limit: 4 });
      } finally {
        index.dispose();
        await provider.dispose();
      }
    });
  });
}
