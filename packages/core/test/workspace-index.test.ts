import { expect } from 'chai';
import { FsError } from '../src/filesystem/fs-error.js';
import { MemoryFileSystemProviderV2 } from '../src/filesystem/memory-provider-v2.js';
import type { FileSystemEntrySnapshot } from '../src/filesystem/v2.js';
import { parseWorkspacePath, type WorkspacePath } from '../src/filesystem/workspace-path.js';
import {
  createWorkspaceIndex,
  type WorkspaceIndex,
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
  options: { readonly watch?: boolean; readonly failList?: (path: string) => FsError | null } = {},
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
