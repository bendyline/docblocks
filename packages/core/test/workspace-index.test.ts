import { expect } from 'chai';
import { FsError } from '../src/filesystem/fs-error.js';
import { MemoryFileSystemProviderV2 } from '../src/filesystem/memory-provider-v2.js';
import type { FileSystemEntrySnapshot } from '../src/filesystem/v2.js';
import { parseWorkspacePath, type WorkspacePath } from '../src/filesystem/workspace-path.js';
import {
  createMemoryEngine,
  createWorkspaceIndex,
  type StoredDocument,
  type WorkspaceIndex,
  type WorkspaceIndexEngine,
  type WorkspaceIndexOptions,
  type WorkspaceIndexSource,
} from '../src/workspace-index/index.js';

const encode = (text: string) => new TextEncoder().encode(text);
const p = (path: string): WorkspacePath => parseWorkspacePath(path);
let sequence = 0;

async function seed(files: Record<string, string>): Promise<MemoryFileSystemProviderV2> {
  const provider = new MemoryFileSystemProviderV2(`index-${++sequence}`, 'Index test');
  for (const [path, text] of Object.entries(files)) {
    await provider.writeFile(p(path), encode(text), { createParents: true });
  }
  return provider;
}

interface Spy {
  readonly source: WorkspaceIndexSource;
  readonly reads: string[];
  readonly lists: string[];
}

/** Records calls; optionally hides `watch` to model IndexedDB / native folders. */
function spy(
  provider: MemoryFileSystemProviderV2,
  options: { readonly watch?: boolean; readonly failList?: (path: string) => Error | null } = {},
): Spy {
  const reads: string[] = [];
  const lists: string[] = [];
  const source: WorkspaceIndexSource = {
    stat: (path) => provider.stat(path),
    readFile: (path) => {
      reads.push(path);
      return provider.readFile(path);
    },
    readDirectory: (path) => {
      lists.push(path);
      const failure = options.failList?.(path) ?? null;
      return failure ? Promise.reject(failure) : provider.readDirectory(path);
    },
    ...(options.watch === false
      ? { capabilities: { watch: false } }
      : { capabilities: provider.capabilities, watch: provider.watch.bind(provider) }),
  };
  return { source, reads, lists };
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

async function waitFor(predicate: () => boolean, label = 'condition'): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

const settled = (index: WorkspaceIndex) => () => {
  const status = index.getStatus();
  return status.phase === 'ready' || status.phase === 'error';
};

describe('workspace index', () => {
  it('includes parents discovered by a leaf-only invalidation', async () => {
    const provider = await seed({ 'source.md': '# Source' });
    const index = createIndex(spy(provider, { watch: false }).source);
    index.start();
    try {
      await waitFor(settled(index), 'ready');
      await provider.writeFile(p('reference/nested/new.md'), encode('# New'), {
        createParents: true,
      });
      index.invalidate('reference/nested/new.md');
      await waitFor(() => index.getDocument('reference/nested/new.md') !== null);
      expect(index.getDirectories()).to.include('reference').and.include('reference/nested');
    } finally {
      index.dispose();
      await provider.dispose();
    }
  });
  it('exposes empty discoverable folders and refreshes them after changes', async () => {
    const provider = await seed({ 'source.md': '# Source' });
    await provider.createDirectory(p('empty'));
    await provider.createDirectory(p('source_files'));
    const index = createIndex(spy(provider).source);
    index.start();
    try {
      await waitFor(settled(index), 'ready');
      expect(index.getDirectories()).to.include('empty').and.not.include('source_files');
      const before = index.getDirectories();
      expect(index.getDirectories()).to.equal(before);
      await provider.createDirectory(p('new'));
      await waitFor(() => index.getDirectories().includes(p('new')), 'new folder');
      expect(index.getDirectories()).not.to.equal(before);
      await provider.remove(p('empty'));
      await waitFor(() => !index.getDirectories().includes(p('empty')), 'removed folder');
    } finally {
      await index.dispose();
      await provider.dispose();
    }
  });
  it('lists discoverable files and analyzes documents in the background', async () => {
    const provider = await seed({
      'guide.md': '---\ntitle: The Guide\n---\n\n# Ignored heading\n\n## Setup\n\nInstall it.\n',
      'notes/plain.md': '# Plain Notes\n\nBody text.\n',
      'notes/untitled.md': 'No heading here.\n',
      'notes/photo.png': 'png',
      'guide_files/media.png': 'media',
      '.git/config': 'hidden',
      'node_modules/pkg/readme.md': '# Package\n',
      '_squisq/squisq-player.js': 'runtime',
    });
    const index = createIndex(spy(provider).source);
    index.start();
    await waitFor(settled(index), 'ready');

    expect(index.getFiles().map((file) => file.path)).to.deep.equal([
      'guide.md',
      'notes/photo.png',
      'notes/plain.md',
      'notes/untitled.md',
    ]);
    expect(index.getFiles().find((file) => file.path === 'notes/photo.png')?.kind).to.equal(
      'other',
    );
    const guide = index.getDocument('/guide.md');
    expect(guide?.title).to.equal('The Guide');
    expect(guide?.outline.map((entry) => entry.title)).to.deep.equal(['Ignored heading', 'Setup']);
    expect(guide?.content).to.equal('full');
    expect(index.getDocument('notes/plain.md')?.title).to.equal('Plain Notes');
    expect(index.getDocument('notes/untitled.md')?.title).to.equal('untitled');
    const status = index.getStatus();
    expect(status.listed).to.equal(true);
    expect(status.pendingCount).to.equal(0);
    expect(status.watching).to.equal(true);
    index.dispose();
  });

  it('indexes an outside-in document through its Markdown companion', async () => {
    const provider = await seed({
      'report.docx': 'binary',
      'report_files/report.md': '# Quarterly Report\n\nRevenue grew.\n',
      'orphan.pdf': 'binary',
    });
    const index = createIndex(spy(provider).source);
    index.start();
    await waitFor(settled(index), 'ready');

    const report = index.getDocument('report.docx');
    expect(report?.format).to.equal('docx');
    expect(report?.sourcePath).to.equal('report_files/report.md');
    expect(report?.title).to.equal('Quarterly Report');
    expect(index.getDocument('orphan.pdf')?.issue).to.equal('no-companion');
    const result = await index.search({ text: 'revenue' });
    expect(result.documents.map((document) => document.path)).to.deep.equal(['report.docx']);
    index.dispose();
  });

  it('follows provider watch events for edits, creation, removal, and moves', async () => {
    const provider = await seed({ 'a.md': '# Alpha\n', 'b.md': '# Beta\n' });
    const index = createIndex(spy(provider).source);
    index.start();
    await waitFor(settled(index), 'ready');

    await provider.writeFile(p('a.md'), encode('# Alpha Renamed\n'));
    await waitFor(() => index.getDocument('a.md')?.title === 'Alpha Renamed', 'edit');

    await provider.writeFile(p('c.md'), encode('# Gamma\n'));
    await waitFor(() => index.getDocument('c.md')?.title === 'Gamma', 'create');

    await provider.remove(p('b.md'));
    await waitFor(() => index.getDocument('b.md') === null, 'remove');
    expect(index.has('b.md')).to.equal('absent');

    await provider.move(p('c.md'), p('archive/c.md'), { createParents: true });
    await waitFor(() => index.getDocument('archive/c.md')?.title === 'Gamma', 'move');
    expect(index.getDocument('c.md')).to.equal(null);
    index.dispose();
  });

  it('refreshes non-watching providers on request and re-reads only changed documents', async () => {
    const provider = await seed({ 'a.md': '# Alpha\n', 'b.md': '# Beta\n' });
    const probe = spy(provider, { watch: false });
    const index = createIndex(probe.source);
    index.start();
    await waitFor(settled(index), 'ready');
    expect(index.getStatus().watching).to.equal(false);
    expect([...probe.reads].sort()).to.deep.equal(['a.md', 'b.md']);

    await provider.writeFile(p('a.md'), encode('# Alpha Two\n'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(index.getDocument('a.md')?.title).to.equal('Alpha');

    probe.reads.length = 0;
    index.refresh();
    await waitFor(() => index.getDocument('a.md')?.title === 'Alpha Two', 'refresh');
    await waitFor(settled(index), 'settled');
    expect(probe.reads).to.deep.equal(['a.md']);

    probe.reads.length = 0;
    await provider.writeFile(p('b.md'), encode('# Beta Two\n'));
    index.invalidate('/b.md');
    await waitFor(() => index.getDocument('b.md')?.title === 'Beta Two', 'invalidate');
    expect(probe.reads).to.deep.equal(['b.md']);
    index.dispose();
  });

  it('reports unreadable folders as unknown rather than absent', async () => {
    const provider = await seed({ 'open/a.md': '# A\n', 'locked/b.md': '# B\n' });
    const probe = spy(provider, {
      failList: (path) =>
        path === 'locked'
          ? new FsError('permission-denied', 'No access.', { operation: 'list', path })
          : null,
    });
    const index = createIndex(probe.source);
    index.start();
    await waitFor(settled(index), 'ready');

    expect(index.getStatus().issues).to.equal(1);
    expect(index.has('open/a.md')).to.equal('present');
    expect(index.has('open/missing.md')).to.equal('absent');
    expect(index.has('locked/b.md')).to.equal('unknown');
    expect(index.has('.git/config')).to.equal('unknown');
    index.dispose();
  });

  it('recognizes a vanished folder reported by another copy of core', async () => {
    // A bundle can resolve the provider from core's src and the index from its
    // dist: same error shape, different FsError class.
    class ForeignFsError extends Error {
      public readonly code: string;
      public constructor(code: string, message: string) {
        super(message);
        this.name = 'FsError';
        this.code = code;
      }
    }
    const provider = await seed({ 'open/a.md': '# A\n', 'gone/b.md': '# B\n' });
    const probe = spy(provider, {
      failList: (path) => (path === 'gone' ? new ForeignFsError('not-found', 'Gone.') : null),
    });
    const index = createIndex(probe.source);
    index.start();
    await waitFor(settled(index), 'ready');

    // Vanished, not unreadable: no issue, and its contents are known absent.
    expect(index.getStatus().issues).to.equal(0);
    expect(index.has('open/a.md')).to.equal('present');
    expect(index.has('gone/b.md')).to.equal('absent');
    index.dispose();
  });

  it('surfaces a root listing failure as an error', async () => {
    const provider = await seed({ 'a.md': '# A\n' });
    const probe = spy(provider, {
      failList: (path) =>
        path === ''
          ? new FsError('permission-denied', 'Access revoked.', { operation: 'list' })
          : null,
    });
    const index = createIndex(probe.source);
    const listed = index.whenListed();
    index.start();
    expect(await listed).to.equal(false);
    await waitFor(settled(index), 'error');
    expect(index.getStatus().phase).to.equal('error');
    expect(index.getStatus().error).to.contain('Access revoked');
    index.dispose();
  });

  it('truncates at the entry budget and keeps what it listed', async () => {
    const files: Record<string, string> = {};
    for (let number = 0; number < 10; number += 1) files[`doc-${number}.md`] = `# Doc ${number}\n`;
    const provider = await seed(files);
    const index = createIndex(spy(provider).source, { limits: { maxEntries: 4 } });
    index.start();
    await waitFor(settled(index), 'ready');

    expect(index.getStatus().truncated).to.deep.equal({ reason: 'entries', limit: 4 });
    expect(index.getFiles()).to.have.length(4);
    expect(index.has('doc-9.md')).to.equal('unknown');
    index.dispose();
  });

  it('keeps oversized documents by name and searches over-deep ones line by line', async () => {
    const provider = await seed({
      'huge.md': `# Huge\n\n${'x'.repeat(400)}\n`,
      'long.md': `# Long\n\n${'needle line\n'.repeat(20)}`,
    });
    const probe = spy(provider);
    const index = createIndex(probe.source, {
      limits: { maxDocumentBytes: 300, maxParseBytes: 100 },
    });
    index.start();
    await waitFor(settled(index), 'ready');

    expect(index.getDocument('huge.md')?.issue).to.equal('too-large');
    expect(probe.reads).to.not.include('huge.md');
    const long = index.getDocument('long.md');
    expect(long?.content).to.equal('lines');
    expect(long?.title).to.equal('Long');
    const result = await index.search({ text: 'needle' });
    expect(result.documents[0]?.matchCount).to.equal(20);
    expect(result.skippedDocuments).to.equal(1);
    index.dispose();
  });

  it('indexes online-only documents by name without downloading them', async () => {
    const provider = await seed({ 'local.md': '# Local\n', 'cloud.md': '# Cloud\n' });
    const probe = spy(provider, { watch: false });
    let cloudOnline = true;
    const flag = (entry: FileSystemEntrySnapshot): FileSystemEntrySnapshot =>
      cloudOnline && entry.kind === 'file' && entry.path === 'cloud.md'
        ? { ...entry, onlineOnly: true }
        : entry;
    const index = createIndex({
      ...probe.source,
      stat: async (path) => {
        const entry = await probe.source.stat(path);
        return entry && flag(entry);
      },
      readDirectory: async (path) => (await probe.source.readDirectory(path)).map(flag),
    });
    index.start();
    await waitFor(settled(index), 'ready');

    expect(probe.reads).to.deep.equal(['local.md']);
    expect(index.getDocument('cloud.md')?.issue).to.equal('online-only');
    expect(index.getDocument('cloud.md')?.title).to.equal('cloud');
    expect(index.getStatus().pendingCount).to.equal(0);

    // Once the file is on this device, the next listing reads it.
    cloudOnline = false;
    probe.reads.length = 0;
    index.refresh();
    await waitFor(() => index.getDocument('cloud.md')?.title === 'Cloud', 'download');
    expect(probe.reads).to.deep.equal(['cloud.md']);
    index.dispose();
  });

  it('stops issuing provider calls once disposed mid-listing', async () => {
    const provider = await seed({ 'a/one.md': '# One\n', 'b/two.md': '# Two\n' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const source: WorkspaceIndexSource = {
      stat: (path) => provider.stat(path),
      readFile: (path) => {
        calls.push(`read:${path}`);
        return provider.readFile(path);
      },
      readDirectory: async (path): Promise<readonly FileSystemEntrySnapshot[]> => {
        calls.push(`list:${path}`);
        await gate;
        return provider.readDirectory(path);
      },
    };
    const index = createIndex(source);
    const listed = index.whenListed();
    index.start();
    await waitFor(() => calls.length === 1, 'first listing');
    index.dispose();
    release();
    expect(await listed).to.equal(false);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls).to.deep.equal(['list:']);
    expect(index.getStatus().phase).to.equal('disposed');
  });

  it('never reaches write methods on its source', async () => {
    const provider = await seed({ 'a.md': '# A\n' });
    const touched: string[] = [];
    const guarded = new Proxy(provider, {
      get(target, property, receiver) {
        if (
          ['writeFile', 'createDirectory', 'remove', 'move', 'snapshot'].includes(String(property))
        ) {
          touched.push(String(property));
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const index = createIndex(guarded);
    index.start();
    await waitFor(settled(index), 'ready');
    await index.search({ text: 'a' });
    expect(touched).to.deep.equal([]);
    index.dispose();
  });

  it('analyzes prioritized documents first', async () => {
    const provider = await seed({ 'a.md': '# A\n', 'b.md': '# B\n', 'c.md': '# C\n' });
    const probe = spy(provider, { watch: false });
    const index = createIndex(probe.source);
    index.prioritize(['c.md']);
    index.start();
    index.prioritize(['/b.md']);
    await waitFor(settled(index), 'ready');
    expect(probe.reads[0]).to.equal('b.md');
    index.dispose();
  });
});

describe('workspace index engines', () => {
  /** The memory engine, recording what the index asks of it and restoring `stored`. */
  function recordingEngine(stored: ReadonlyMap<WorkspacePath, StoredDocument> = new Map()) {
    const inner = createMemoryEngine();
    const calls = { analyzed: [] as string[], forgotten: [] as string[], searches: 0, disposed: 0 };
    const engine: WorkspaceIndexEngine = {
      restore: () => Promise.resolve(stored),
      analyze: (identity, version, data, options) => {
        calls.analyzed.push(identity.path);
        return inner.analyze(identity, version, data, options);
      },
      forget: (path) => {
        calls.forgotten.push(path);
        inner.forget(path);
      },
      search: (documents, query, options) => {
        calls.searches += 1;
        return inner.search(documents, query, options);
      },
      dispose: () => {
        calls.disposed += 1;
        inner.dispose();
      },
    };
    return { engine, calls };
  }

  async function storedFrom(
    provider: MemoryFileSystemProviderV2,
    path: string,
    title: string,
  ): Promise<StoredDocument> {
    const entry = await provider.stat(p(path));
    if (!entry) throw new Error(`missing ${path}`);
    return {
      record: {
        path: p(path),
        sourcePath: p(path),
        format: 'markdown',
        lastModified: entry.lastModified,
        title,
        outline: [],
        wordCount: 1,
        content: 'full',
      },
      characters: 10,
      version: entry.version,
    };
  }

  it('skips reading documents an earlier session analyzed at the same version', async () => {
    const provider = await seed({ 'kept.md': '# Kept\n', 'changed.md': '# Changed\n' });
    const kept = await storedFrom(provider, 'kept.md', 'Kept (stored)');
    const changed = {
      ...(await storedFrom(provider, 'changed.md', 'Old')),
      version: 'stale' as never,
    };
    const { engine, calls } = recordingEngine(
      new Map([
        [p('kept.md'), kept],
        [p('changed.md'), changed],
      ]),
    );
    const probe = spy(provider, { watch: false });
    const index = createIndex(probe.source, { engine });
    index.start();
    await waitFor(settled(index), 'ready');

    expect(probe.reads).to.deep.equal(['changed.md']);
    expect(calls.analyzed).to.deep.equal(['changed.md']);
    expect(index.getDocument('kept.md')?.title).to.equal('Kept (stored)');
    expect(index.getDocument('changed.md')?.title).to.equal('Changed');
    index.dispose();
    expect(calls.disposed).to.equal(1);
  });

  it('forgets stored documents the workspace no longer has, and removed ones', async () => {
    const provider = await seed({ 'a.md': '# A\n', 'b.md': '# B\n' });
    const gone = await storedFrom(provider, 'a.md', 'Gone');
    const { engine, calls } = recordingEngine(
      new Map([
        [
          p('deleted-while-closed.md'),
          { ...gone, record: { ...gone.record, path: p('deleted-while-closed.md') } },
        ],
      ]),
    );
    const index = createIndex(spy(provider).source, { engine });
    index.start();
    await waitFor(settled(index), 'ready');
    expect(calls.forgotten).to.deep.equal(['deleted-while-closed.md']);

    await provider.remove(p('b.md'));
    await waitFor(() => index.getDocument('b.md') === null, 'remove');
    expect(calls.forgotten).to.include('b.md');
    index.dispose();
  });

  it('keeps text for documents re-listed when their folder changes', async () => {
    const provider = await seed({ 'notes/a.md': '# A\n\nheron\n' });
    const { engine, calls } = recordingEngine();
    const probe = spy(provider);
    const index = createIndex(probe.source, { engine });
    index.start();
    await waitFor(settled(index), 'ready');
    await provider.writeFile(p('notes/b.md'), encode('# B\n'));
    await waitFor(() => index.getDocument('notes/b.md')?.title === 'B', 'create');
    const listed = probe.lists.filter((path) => path === 'notes').length;
    index.invalidate('notes');
    await waitFor(
      () => probe.lists.filter((path) => path === 'notes').length > listed,
      'folder re-listed',
    );
    await waitFor(settled(index), 'settled');
    expect(calls.forgotten).to.not.include('notes/a.md');
    const result = await index.search({ text: 'heron' });
    expect(result.documents.map((document) => document.path)).to.deep.equal(['notes/a.md']);
    expect(calls.searches).to.be.greaterThan(0);
    index.dispose();
  });
});

describe('workspace index over a recursive listing', () => {
  /**
   * A source with `enumerate`, built over the memory provider. Its versions
   * describe metadata, like the desktop host's: never equal to a read's
   * content version, so tagging must follow the listing.
   */
  function enumerating(
    provider: MemoryFileSystemProviderV2,
    options: { readonly notSupported?: boolean; readonly unreadable?: string } = {},
  ) {
    const probe = spy(provider, { watch: false });
    const counts = { enumerations: 0 };
    const source: WorkspaceIndexSource = {
      ...probe.source,
      async *enumerate(root) {
        counts.enumerations += 1;
        if (options.notSupported) {
          throw new FsError('not-supported', 'Older host.', { operation: 'list' });
        }
        const queue: WorkspacePath[] = [root];
        while (queue.length > 0) {
          const folder = queue.shift()!;
          if (folder === options.unreadable) {
            yield { entries: [], unreadable: [folder] };
            continue;
          }
          const children = await provider.readDirectory(folder);
          const entries = children
            .filter((child) => !child.name.startsWith('.'))
            .map((child) => ({ ...child, version: `meta:${child.version}` as never }));
          for (const child of entries) {
            if (child.kind === 'directory' && !child.name.endsWith('_files'))
              queue.push(child.path);
          }
          yield { entries, unreadable: [] };
        }
      },
    };
    return { source, probe, counts };
  }

  it('lists without per-folder calls and re-reads only what changed', async () => {
    const provider = await seed({
      'a.md': '# Alpha\n',
      'notes/b.md': '# Beta\n\nheron\n',
      'notes/deep/c.md': '# Gamma\n',
      'report.docx': 'binary',
      'report_files/report.md': '# Quarterly Report\n\nRevenue grew.\n',
    });
    const { source, probe, counts } = enumerating(provider);
    const index = createIndex(source);
    index.start();
    await waitFor(settled(index), 'ready');

    // Only the outside-in document's companion folder is listed on its own.
    expect(probe.lists).to.deep.equal(['report_files']);
    expect(index.getDocument('notes/deep/c.md')?.title).to.equal('Gamma');
    expect(index.getDocument('report.docx')?.title).to.equal('Quarterly Report');
    expect(index.getDirectories()).to.include('notes/deep');
    expect((await index.search({ text: 'heron' })).documents.map((d) => d.path)).to.deep.equal([
      'notes/b.md',
    ]);
    const reads = probe.reads.length;

    index.refresh({ force: true });
    await waitFor(() => counts.enumerations === 2, 'second listing');
    await waitFor(settled(index), 'settled');
    expect(probe.reads.length).to.equal(reads);

    await provider.writeFile(p('notes/b.md'), encode('# Beta again\n'));
    index.refresh({ force: true });
    await waitFor(() => index.getDocument('notes/b.md')?.title === 'Beta again', 'edit');
    expect(probe.reads.slice(reads)).to.deep.equal(['notes/b.md']);
    index.dispose();
  });

  it('walks folders instead when the host cannot enumerate', async () => {
    const provider = await seed({ 'a.md': '# Alpha\n', 'notes/b.md': '# Beta\n' });
    const { source, probe, counts } = enumerating(provider, { notSupported: true });
    const index = createIndex(source);
    index.start();
    await waitFor(settled(index), 'ready');
    expect(probe.lists).to.include.members(['', 'notes']);
    expect(index.getDocument('notes/b.md')?.title).to.equal('Beta');

    index.refresh({ force: true });
    await waitFor(() => probe.lists.filter((path) => path === '').length === 2, 'second walk');
    expect(counts.enumerations).to.equal(1);
    index.dispose();
  });

  it('treats a folder it could not read as unknown, not absent', async () => {
    const provider = await seed({ 'open/a.md': '# A\n', 'locked/b.md': '# B\n' });
    const { source } = enumerating(provider, { unreadable: 'locked' });
    const index = createIndex(source);
    index.start();
    await waitFor(settled(index), 'ready');
    expect(index.getStatus().issues).to.equal(1);
    expect(index.has('open/a.md')).to.equal('present');
    expect(index.has('locked/b.md')).to.equal('unknown');
    expect(index.has('open/missing.md')).to.equal('absent');
    index.dispose();
  });
});
