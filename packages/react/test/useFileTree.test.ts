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
import {
  FsError,
  MemoryFileSystemProvider,
  parseWorkspacePath,
} from '@bendyline/docblocks/filesystem';
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
const RETRY_SETTLE = 220;

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

  it('refreshes only the containing listing for watched file metadata changes', async () => {
    const provider = new MemoryFileSystemProvider('watched', 'Watched');
    await provider.v2.writeFile(parseWorkspacePath('note.md'), new Uint8Array([1]), {
      mode: 'create',
    });
    const handle = await renderHook(
      (p: { provider: FileSystemProvider | null }) => useFileTree(p.provider),
      { provider },
    );
    await advanceTime(SETTLE);
    expect(handle.result.current.entries.map((entry) => entry.name)).to.deep.equal(['note.md']);

    const readDirectory = provider.v2.readDirectory.bind(provider.v2);
    let refreshReads = 0;
    provider.v2.readDirectory = async (path) => {
      refreshReads += 1;
      return readDirectory(path);
    };

    await act(async () => {
      await provider.v2.writeFile(parseWorkspacePath('note.md'), new Uint8Array([2]), {
        mode: 'replace',
      });
    });
    await advanceTime(SETTLE);

    expect(refreshReads).to.equal(1);
    expect(handle.result.current.entries.map((entry) => entry.name)).to.deep.equal(['note.md']);
    expect(handle.result.current.entries[0]?.lastModified).to.be.a('string');
    await handle.unmount();
    await provider.v2.dispose();
  });

  it('keeps an unchanged refreshed listing referentially stable', async () => {
    const provider = makeProvider({
      '': [file('note.md'), dir('docs')],
      '/docs': [file('other.md', '/docs')],
    });
    const handle = await renderHook(
      (p: { provider: FileSystemProvider | null }) => useFileTree(p.provider),
      { provider },
    );
    await advanceTime(SETTLE);
    await act(async () => handle.result.current.toggleExpand('/docs'));
    await advanceTime(SETTLE);

    const rootEntries = handle.result.current.entries;
    const childEntries = handle.result.current.childEntries;
    const childListing = childEntries.get('docs');
    const normalRead = provider.readDirectory.bind(provider);
    let releaseRoot!: () => void;
    const rootReleased = new Promise<void>((resolve) => {
      releaseRoot = resolve;
    });
    provider.readDirectory = async (path: string) => {
      if (normalisePath(path) === '') await rootReleased;
      return normalRead(path);
    };
    let refresh!: Promise<void>;
    await act(async () => {
      refresh = handle.result.current.refresh();
      await Promise.resolve();
    });

    expect(handle.result.current.loading).to.equal(false);
    expect(handle.result.current.entries).to.equal(rootEntries);
    await act(async () => {
      releaseRoot();
      await refresh;
    });
    expect(handle.result.current.childEntries).to.equal(childEntries);
    expect(handle.result.current.childEntries.get('docs')).to.equal(childListing);
    await handle.unmount();
  });

  it('reuses unaffected entries when refreshed metadata changes', async () => {
    const provider = makeProvider({
      '': [
        { ...file('note.md'), lastModified: '2026-07-22T10:00:00.000Z' },
        { ...file('other.md'), lastModified: '2026-07-21T10:00:00.000Z' },
      ],
    });
    const handle = await renderHook(
      (p: { provider: FileSystemProvider | null }) => useFileTree(p.provider),
      { provider },
    );
    await advanceTime(SETTLE);

    const note = handle.result.current.entries[0];
    const other = handle.result.current.entries[1];
    provider.tree[''] = [
      { ...file('note.md'), lastModified: '2026-07-22T11:00:00.000Z' },
      { ...file('other.md'), lastModified: '2026-07-21T10:00:00.000Z' },
    ];
    await act(async () => handle.result.current.refresh());

    expect(handle.result.current.entries[0]).not.to.equal(note);
    expect(handle.result.current.entries[1]).to.equal(other);
    await handle.unmount();
  });

  it('refreshes only affected parent listings for watched structural changes', async () => {
    const provider = new MemoryFileSystemProvider('watched-structure', 'Watched structure');
    await provider.v2.createDirectory(parseWorkspacePath('docs'), { mode: 'create' });
    const handle = await renderHook(
      (p: { provider: FileSystemProvider | null }) => useFileTree(p.provider),
      { provider },
    );
    await advanceTime(SETTLE);
    await act(async () => handle.result.current.toggleExpand('docs'));
    await advanceTime(SETTLE);

    const readDirectory = provider.v2.readDirectory.bind(provider.v2);
    const refreshedPaths: string[] = [];
    provider.v2.readDirectory = async (path) => {
      refreshedPaths.push(path);
      return readDirectory(path);
    };
    await act(async () => {
      await provider.v2.writeFile(parseWorkspacePath('docs/new.md'), new Uint8Array([1]), {
        mode: 'create',
      });
    });
    await advanceTime(SETTLE);

    expect(refreshedPaths).to.deep.equal(['docs']);
    expect(
      handle.result.current.childEntries.get('docs')?.map((entry) => entry.name),
    ).to.deep.equal(['new.md']);
    await handle.unmount();
    await provider.v2.dispose();
  });

  it('silently refreshes only the active file listing when a non-watch provider saves', async () => {
    const provider = makeProvider({
      '': [
        {
          ...file('note.md'),
          lastModified: '2026-07-22T10:00:00.000Z',
        },
        dir('docs'),
      ],
      '/docs': [file('other.md', '/docs')],
    });
    const handle = await renderHook(
      (p: {
        provider: FileSystemProvider;
        metadataRefreshKey: number;
        metadataRefreshPath: string;
      }) => useFileTree(p.provider, p.metadataRefreshKey, p.metadataRefreshPath),
      { provider, metadataRefreshKey: 0, metadataRefreshPath: '/note.md' },
    );
    await advanceTime(SETTLE);
    await act(async () => handle.result.current.toggleExpand('/docs'));
    await advanceTime(SETTLE);

    provider.readDirCalls.length = 0;
    provider.tree[''] = [
      {
        ...file('note.md'),
        lastModified: '2026-07-22T11:00:00.000Z',
      },
      dir('docs'),
    ];
    const normalRead = provider.readDirectory.bind(provider);
    let releaseRefresh!: () => void;
    const refreshReleased = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    provider.readDirectory = async (path: string) => {
      if (normalisePath(path) === '') await refreshReleased;
      return normalRead(path);
    };

    await handle.rerender({ provider, metadataRefreshKey: 1, metadataRefreshPath: '/note.md' });
    await advanceTime(0);

    expect(
      handle.result.current.loading,
      'autosave must not replace the tree with Loading',
    ).to.equal(false);
    expect(handle.result.current.entries[0]?.lastModified).to.equal('2026-07-22T10:00:00.000Z');

    await act(async () => releaseRefresh());
    await advanceTime(SETTLE);

    expect(provider.readDirCalls).to.deep.equal(['']);
    expect(handle.result.current.entries[0]?.lastModified).to.equal('2026-07-22T11:00:00.000Z');
    await handle.unmount();
  });

  it('does not add a focus refresh when the provider already has a watch barrier', async () => {
    const provider = new MemoryFileSystemProvider('watched-focus', 'Watched focus');
    const handle = await renderHook(
      (p: { provider: FileSystemProvider | null }) => useFileTree(p.provider),
      { provider },
    );
    await advanceTime(SETTLE);

    const readDirectory = provider.v2.readDirectory.bind(provider.v2);
    let focusReads = 0;
    provider.v2.readDirectory = async (path) => {
      focusReads += 1;
      return readDirectory(path);
    };

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await advanceTime(SETTLE);

    expect(focusReads).to.equal(0);
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

  it('does not let an older same-provider failure replace a newer healthy root read', async () => {
    const provider = makeProvider({ '': [file('initial.md')] });
    const handle = await renderHook(
      (p: { provider: FileSystemProvider | null }) => useFileTree(p.provider),
      { provider: provider as FileSystemProvider },
    );
    await advanceTime(SETTLE);

    let releaseOlder!: () => void;
    const olderReleased = new Promise<void>((resolve) => {
      releaseOlder = resolve;
    });
    const normalRead = provider.readDirectory.bind(provider);
    let refreshRead = 0;
    provider.tree[''] = [file('current.md')];
    provider.readDirectory = async (path: string) => {
      refreshRead += 1;
      if (refreshRead === 1) {
        await olderReleased;
        throw new Error('Stale refresh failed');
      }
      return normalRead(path);
    };

    let olderRefresh!: Promise<void>;
    await act(async () => {
      olderRefresh = handle.result.current.refresh();
      await Promise.resolve();
    });
    await act(async () => {
      await handle.result.current.refresh();
    });

    expect(handle.result.current.entries.map((entry) => entry.name)).to.deep.equal(['current.md']);
    expect(handle.result.current.rootIssue).to.equal(null);

    await act(async () => {
      releaseOlder();
      await olderRefresh;
    });
    expect(handle.result.current.rootIssue).to.equal(null);
    expect(handle.result.current.entries.map((entry) => entry.name)).to.deep.equal(['current.md']);
    await handle.unmount();
  });

  it('recovers from a bounded run of transient root not-found observations', async () => {
    const provider = makeProvider({ '': [file('available.md')] });
    const normalRead = provider.readDirectory.bind(provider);
    let attempts = 0;
    provider.readDirectory = async (path: string) => {
      attempts += 1;
      if (attempts <= 2) {
        throw new FsError('not-found', 'Directory not found.', {
          operation: 'list',
          path: '',
        });
      }
      return normalRead(path);
    };

    const handle = await renderHook(
      (p: { provider: FileSystemProvider | null }) => useFileTree(p.provider),
      { provider: provider as FileSystemProvider },
    );
    await advanceTime(RETRY_SETTLE);

    expect(attempts).to.equal(3);
    expect(handle.result.current.rootIssue).to.equal(null);
    expect(handle.result.current.error).to.equal(null);
    expect(handle.result.current.entries.map((entry) => entry.name)).to.deep.equal([
      'available.md',
    ]);
    await handle.unmount();
  });

  it('keeps a missing child failure scoped to that directory and retries it independently', async () => {
    const provider = makeProvider({
      '': [dir('docs')],
      '/docs': [file('guide.md', '/docs')],
    });
    const normalRead = provider.readDirectory.bind(provider);
    let childUnavailable = true;
    provider.readDirectory = async (path: string) => {
      if (normalisePath(path) === 'docs' && childUnavailable) {
        throw new FsError('not-found', 'Directory not found.', {
          operation: 'list',
          path: 'docs',
        });
      }
      return normalRead(path);
    };
    const handle = await renderHook(
      (p: { provider: FileSystemProvider | null }) => useFileTree(p.provider),
      { provider: provider as FileSystemProvider },
    );
    await advanceTime(SETTLE);

    await act(async () => {
      handle.result.current.toggleExpand('/docs');
    });
    await advanceTime(RETRY_SETTLE);

    expect(handle.result.current.error).to.equal(null);
    expect(handle.result.current.rootIssue).to.equal(null);
    expect(handle.result.current.childIssues.get('docs')).to.deep.include({
      directoryPath: 'docs',
      path: 'docs',
      code: 'not-found',
      message: 'Directory not found.',
    });

    childUnavailable = false;
    await act(async () => {
      await handle.result.current.retryDirectory('/docs');
    });

    expect(handle.result.current.childIssues.has('docs')).to.equal(false);
    expect(
      handle.result.current.childEntries.get('docs')?.map((entry) => entry.name),
    ).to.deep.equal(['guide.md']);
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
    expect(handle.result.current.rootIssue).to.deep.include({
      directoryPath: '',
      path: '',
      message: 'Workspace permission was revoked',
    });
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
