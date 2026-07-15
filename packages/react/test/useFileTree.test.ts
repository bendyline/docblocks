/**
 * Tests for useFileTree — the state machine behind the FileExplorer
 * component. Covers:
 *
 *   • Initial root load when a provider is attached
 *   • Selection (select / clear-on-delete / move-on-rename)
 *   • Expand/collapse + lazy child load
 *   • CRUD actions delegate to the provider and refresh the tree
 *   • Provider watch events and window resume refresh visible directories
 *   • Null-provider path: actions are no-ops, root is empty
 */
import { expect } from 'chai';
import { MemoryFileSystemProvider, parseWorkspacePath } from '@bendyline/docblocks/filesystem';
import type {
  FileSystemProvider,
  FileSystemEntry,
  FileMeta,
} from '@bendyline/docblocks/filesystem';
import { useFileTree } from '../src/FileExplorer/useFileTree.js';
import { act, advanceTime, renderHook } from './helpers/renderHook.js';

interface InMemoryTree {
  [absPath: string]: FileSystemEntry[];
}

interface MemoryProvider extends FileSystemProvider {
  readDirCalls: string[];
  writeCalls: { path: string; content: string }[];
  deleteCalls: string[];
  renameCalls: { from: string; to: string }[];
  createDirCalls: string[];
  tree: InMemoryTree;
  existingPaths: Set<string>;
}

function normalisePath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

function file(name: string, parent = ''): FileSystemEntry {
  return { kind: 'file', name, path: parent ? `${parent}/${name}` : `/${name}` };
}
function dir(name: string, parent = ''): FileSystemEntry {
  return { kind: 'directory', name, path: parent ? `${parent}/${name}` : `/${name}` };
}

function makeProvider(initial: InMemoryTree): MemoryProvider {
  const readDirCalls: string[] = [];
  const writeCalls: { path: string; content: string }[] = [];
  const deleteCalls: string[] = [];
  const renameCalls: { from: string; to: string }[] = [];
  const createDirCalls: string[] = [];
  const tree: InMemoryTree = JSON.parse(JSON.stringify(initial));
  const existingPaths = new Set<string>();
  for (const [parent, entries] of Object.entries(tree)) {
    if (parent) existingPaths.add(normalisePath(parent));
    for (const entry of entries) existingPaths.add(normalisePath(entry.path));
  }

  const p: MemoryProvider = {
    id: 'mem',
    label: 'Memory',
    tree,
    readDirCalls,
    writeCalls,
    deleteCalls,
    renameCalls,
    createDirCalls,
    existingPaths,
    async readFile() {
      return null;
    },
    async writeFile(path: string, content: string) {
      writeCalls.push({ path, content });
      existingPaths.add(normalisePath(path));
    },
    async delete(path: string) {
      deleteCalls.push(path);
      existingPaths.delete(normalisePath(path));
    },
    async rename(from: string, to: string) {
      renameCalls.push({ from, to });
      existingPaths.delete(normalisePath(from));
      existingPaths.add(normalisePath(to));
    },
    async readDirectory(path: string) {
      readDirCalls.push(path);
      return tree[path] ?? [];
    },
    async exists(path: string) {
      return existingPaths.has(normalisePath(path));
    },
    async createDirectory(path: string) {
      createDirCalls.push(path);
      existingPaths.add(normalisePath(path));
    },
    async stat(): Promise<FileMeta | null> {
      return null;
    },
    async readBinary() {
      return null;
    },
    async writeBinary() {},
  };
  return p;
}

const SETTLE = 30;

describe('useFileTree', () => {
  it('starts empty with a null provider', async () => {
    const handle = await renderHook(
      (p: { provider: FileSystemProvider | null }) => useFileTree(p.provider),
      {
        provider: null,
      },
    );
    expect(handle.result.current.entries).to.deep.equal([]);
    expect(handle.result.current.selectedPath).to.equal(null);
    expect(handle.result.current.loading).to.equal(false);
    await handle.unmount();
  });

  it('loads the root directory when a provider is attached', async () => {
    const provider = makeProvider({
      '': [file('readme.md'), dir('docs')],
    });
    const handle = await renderHook(
      (p: { provider: FileSystemProvider | null }) => useFileTree(p.provider),
      {
        provider,
      },
    );
    await advanceTime(SETTLE);
    expect(provider.readDirCalls).to.include('');
    expect(handle.result.current.entries).to.have.length(2);
    expect(handle.result.current.entries[0].name).to.equal('readme.md');
    await handle.unmount();
  });

  it('refreshes an empty tree when a watched provider reports a change', async () => {
    const provider = new MemoryFileSystemProvider('watched', 'Watched');
    const handle = await renderHook(
      (p: { provider: FileSystemProvider | null }) => useFileTree(p.provider),
      { provider },
    );
    await advanceTime(SETTLE);
    expect(handle.result.current.entries).to.deep.equal([]);

    await act(async () => {
      await provider.v2.writeFile(parseWorkspacePath('external.md'), new Uint8Array([1]), {
        mode: 'create',
      });
    });
    await advanceTime(SETTLE);

    expect(handle.result.current.entries.map((entry) => entry.name)).to.deep.equal(['external.md']);
    await handle.unmount();
    await provider.v2.dispose();
  });

  it('refreshes the tree when the window regains focus', async () => {
    const provider = makeProvider({ '': [] });
    const handle = await renderHook(
      (p: { provider: FileSystemProvider | null }) => useFileTree(p.provider),
      { provider },
    );
    await advanceTime(SETTLE);
    provider.tree[''] = [file('resumed.md')];

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await advanceTime(SETTLE);

    expect(handle.result.current.entries.map((entry) => entry.name)).to.deep.equal(['resumed.md']);
    await handle.unmount();
  });

  it('select() updates selectedPath + selectedKind', async () => {
    const provider = makeProvider({ '': [file('a.md')] });
    const handle = await renderHook(
      (p: { provider: FileSystemProvider | null }) => useFileTree(p.provider),
      {
        provider,
      },
    );
    await advanceTime(SETTLE);
    await act(async () => {
      handle.result.current.select('/a.md', 'file');
    });
    expect(handle.result.current.selectedPath).to.equal('/a.md');
    expect(handle.result.current.selectedKind).to.equal('file');
    await handle.unmount();
  });

  it('toggleExpand() adds + removes from the expanded set and triggers lazy load', async () => {
    const provider = makeProvider({
      '': [dir('docs')],
      '/docs': [file('intro.md', '/docs')],
    });
    const handle = await renderHook(
      (p: { provider: FileSystemProvider | null }) => useFileTree(p.provider),
      {
        provider,
      },
    );
    await advanceTime(SETTLE);

    await act(async () => {
      handle.result.current.toggleExpand('/docs');
    });
    await advanceTime(SETTLE);
    expect(handle.result.current.expanded.has('/docs')).to.equal(true);
    expect(provider.readDirCalls).to.include('/docs');

    await act(async () => {
      handle.result.current.toggleExpand('/docs');
    });
    expect(handle.result.current.expanded.has('/docs')).to.equal(false);
    await handle.unmount();
  });

  it('reveal() selects an entry and expands every ancestor directory', async () => {
    const provider = makeProvider({
      '': [dir('guides')],
      '/guides': [dir('advanced', '/guides')],
      '/guides/advanced': [file('intro.md', '/guides/advanced')],
    });
    const handle = await renderHook(
      (p: { provider: FileSystemProvider | null }) => useFileTree(p.provider),
      { provider },
    );
    await advanceTime(SETTLE);

    await act(async () => {
      handle.result.current.reveal('/guides/advanced/intro.md', 'file');
    });
    await advanceTime(SETTLE);

    expect(handle.result.current.selectedPath).to.equal('/guides/advanced/intro.md');
    expect(handle.result.current.selectedKind).to.equal('file');
    expect(handle.result.current.expanded).to.include('/guides');
    expect(handle.result.current.expanded).to.include('/guides/advanced');
    expect(provider.readDirCalls).to.include('/guides');
    expect(provider.readDirCalls).to.include('/guides/advanced');
    await handle.unmount();
  });

  it('createFile() delegates to provider and refreshes the tree', async () => {
    const provider = makeProvider({ '': [] });
    const handle = await renderHook(
      (p: { provider: FileSystemProvider | null }) => useFileTree(p.provider),
      {
        provider,
      },
    );
    await advanceTime(SETTLE);
    provider.readDirCalls.length = 0;

    await act(async () => {
      await handle.result.current.createFile('/new.md', '# hi');
    });
    expect(provider.writeCalls).to.deep.equal([{ path: '/new.md', content: '# hi' }]);
    // Refresh re-reads the root after the write.
    expect(provider.readDirCalls).to.include('');
    await handle.unmount();
  });

  it('createDirectory() delegates to provider and refreshes', async () => {
    const provider = makeProvider({ '': [] });
    const handle = await renderHook(
      (p: { provider: FileSystemProvider | null }) => useFileTree(p.provider),
      {
        provider,
      },
    );
    await advanceTime(SETTLE);
    provider.readDirCalls.length = 0;

    await act(async () => {
      await handle.result.current.createDirectory('/inbox');
    });
    expect(provider.createDirCalls).to.deep.equal(['/inbox']);
    expect(provider.readDirCalls).to.include('');
    await handle.unmount();
  });

  it('deleteEntry() clears selection if the deleted entry was selected', async () => {
    const provider = makeProvider({ '': [file('a.md')] });
    const handle = await renderHook(
      (p: { provider: FileSystemProvider | null }) => useFileTree(p.provider),
      {
        provider,
      },
    );
    await advanceTime(SETTLE);
    await act(async () => {
      handle.result.current.select('/a.md', 'file');
    });
    expect(handle.result.current.selectedPath).to.equal('/a.md');

    await act(async () => {
      await handle.result.current.deleteEntry('/a.md');
    });
    expect(provider.deleteCalls).to.deep.equal(['/a.md']);
    expect(handle.result.current.selectedPath).to.equal(null);
    expect(handle.result.current.selectedKind).to.equal(null);
    await handle.unmount();
  });

  it('deleteEntry() leaves an unrelated selection alone', async () => {
    const provider = makeProvider({ '': [file('a.md'), file('b.md')] });
    const handle = await renderHook(
      (p: { provider: FileSystemProvider | null }) => useFileTree(p.provider),
      {
        provider,
      },
    );
    await advanceTime(SETTLE);
    await act(async () => {
      handle.result.current.select('/b.md', 'file');
    });

    await act(async () => {
      await handle.result.current.deleteEntry('/a.md');
    });
    expect(handle.result.current.selectedPath).to.equal('/b.md');
    await handle.unmount();
  });

  it('renameEntry() moves selection from oldPath to newPath', async () => {
    const provider = makeProvider({ '': [file('a.md')] });
    const handle = await renderHook(
      (p: { provider: FileSystemProvider | null }) => useFileTree(p.provider),
      {
        provider,
      },
    );
    await advanceTime(SETTLE);
    await act(async () => {
      handle.result.current.select('/a.md', 'file');
    });

    await act(async () => {
      await handle.result.current.renameEntry('/a.md', '/b.md');
    });
    expect(provider.renameCalls).to.deep.equal([{ from: '/a.md', to: '/b.md' }]);
    expect(handle.result.current.selectedPath).to.equal('/b.md');
    await handle.unmount();
  });

  it('renameEntry() moves a markdown companion directory', async () => {
    const provider = makeProvider({
      '': [file('a.md'), dir('a_files')],
      '/a_files': [file('image.png', '/a_files')],
    });
    const handle = await renderHook(
      (p: { provider: FileSystemProvider | null }) => useFileTree(p.provider),
      { provider },
    );
    await advanceTime(SETTLE);

    await act(async () => {
      await handle.result.current.renameEntry('/a.md', '/b.md', 'file');
    });

    expect(provider.renameCalls).to.deep.equal([
      { from: '/a.md', to: '/b.md' },
      { from: '/a_files', to: '/b_files' },
    ]);
    await handle.unmount();
  });

  it('CRUD actions are no-ops when the provider is null', async () => {
    const handle = await renderHook(
      (p: { provider: FileSystemProvider | null }) => useFileTree(p.provider),
      {
        provider: null,
      },
    );
    // Each of these should resolve without throwing.
    await handle.result.current.createFile('/x.md');
    await handle.result.current.createDirectory('/x');
    await handle.result.current.deleteEntry('/x');
    await handle.result.current.renameEntry('/x', '/y');
    expect(handle.result.current.entries).to.deep.equal([]);
    await handle.unmount();
  });

  it('switching to a new provider reloads the root and clears state', async () => {
    const first = makeProvider({ '': [file('a.md')] });
    const second = makeProvider({ '': [file('b.md')] });
    const handle = await renderHook(
      (p: { provider: FileSystemProvider | null }) => useFileTree(p.provider),
      { provider: first as FileSystemProvider },
    );
    await advanceTime(SETTLE);
    await act(async () => {
      handle.result.current.select('/a.md', 'file');
      handle.result.current.toggleExpand('/a.md');
    });
    await advanceTime(SETTLE);

    await handle.rerender({ provider: second as FileSystemProvider });
    await advanceTime(SETTLE);

    expect(second.readDirCalls).to.include('');
    expect(handle.result.current.selectedPath).to.equal(null);
    expect(handle.result.current.selectedKind).to.equal(null);
    expect(handle.result.current.expanded.size).to.equal(0);
    expect(handle.result.current.entries[0]?.name).to.equal('b.md');
    await handle.unmount();
  });

  it('does not publish a delayed root read from the previous provider', async () => {
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = makeProvider({ '': [file('stale.md')] });
    first.readDirectory = async (path: string) => {
      first.readDirCalls.push(path);
      await firstReleased;
      return first.tree[path] ?? [];
    };
    const second = makeProvider({ '': [file('current.md')] });
    const handle = await renderHook(
      (p: { provider: FileSystemProvider | null }) => useFileTree(p.provider),
      { provider: first as FileSystemProvider },
    );
    await advanceTime(0);

    await handle.rerender({ provider: second as FileSystemProvider });
    await advanceTime(SETTLE);
    expect(handle.result.current.entries.map((entry) => entry.name)).to.deep.equal(['current.md']);

    releaseFirst();
    await advanceTime(SETTLE);
    expect(handle.result.current.entries.map((entry) => entry.name)).to.deep.equal(['current.md']);
    await handle.unmount();
  });

  it('surfaces provider read failures and clears them after a successful retry', async () => {
    const provider = makeProvider({ '': [file('recovered.md')] });
    const normalRead = provider.readDirectory.bind(provider);
    provider.readDirectory = async () => {
      throw new Error('Workspace permission was revoked');
    };
    const handle = await renderHook(
      (p: { provider: FileSystemProvider | null }) => useFileTree(p.provider),
      { provider: provider as FileSystemProvider },
    );
    await advanceTime(SETTLE);

    expect(handle.result.current.loading).to.equal(false);
    expect(handle.result.current.error).to.equal('Workspace permission was revoked');
    expect(handle.result.current.entries).to.deep.equal([]);

    provider.readDirectory = normalRead;
    await act(async () => {
      await handle.result.current.refresh();
    });
    expect(handle.result.current.error).to.equal(null);
    expect(handle.result.current.entries.map((entry) => entry.name)).to.deep.equal([
      'recovered.md',
    ]);
    await handle.unmount();
  });
});
