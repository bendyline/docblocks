import { expect } from 'chai';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  FsError,
  parseWorkspacePath,
  type FileSystemEntrySnapshot,
  type FileSystemEnumerationPage,
} from '@bendyline/docblocks/filesystem';
import {
  NodeWorkspaceFileSystemV2,
  type NodeWorkspaceFileSystemV2Options,
} from '../main/node-workspace-filesystem-v2.js';
import { getWorkspaceRoots } from '../main/workspace-roots.js';

const p = parseWorkspacePath;

async function collect(
  provider: NodeWorkspaceFileSystemV2,
  folder = '',
): Promise<{ pages: FileSystemEnumerationPage[]; entries: FileSystemEntrySnapshot[] }> {
  const pages: FileSystemEnumerationPage[] = [];
  for await (const page of provider.enumerate(p(folder))) pages.push(page);
  return { pages, entries: pages.flatMap((page) => page.entries) };
}

describe('native filesystem metadata enumeration', () => {
  const roots = getWorkspaceRoots();
  const id = 'node-enumerate';
  let rootPath: string;
  let provider: NodeWorkspaceFileSystemV2 | undefined;
  let opened: string[];

  function open(options: NodeWorkspaceFileSystemV2Options = {}): NodeWorkspaceFileSystemV2 {
    provider = new NodeWorkspaceFileSystemV2(id, 'Enumerate', rootPath, roots, {
      openReadableFile: async (absolute) => {
        opened.push(absolute);
        const handle = await fs.open(absolute, 'r');
        return {
          stat: () => handle.stat({ bigint: true }),
          readFile: () => handle.readFile(),
          close: () => handle.close(),
        };
      },
      ...options,
    });
    return provider;
  }

  async function write(relative: string, text = 'x'): Promise<void> {
    const absolute = path.join(rootPath, ...relative.split('/'));
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, text);
  }

  beforeEach(async () => {
    rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'docblocks-enumerate-'));
    roots.register(id, rootPath);
    opened = [];
  });

  afterEach(async () => {
    await provider?.dispose();
    provider = undefined;
    roots.unregister(id);
    await fs.chmod(path.join(rootPath, 'locked'), 0o755).catch(() => undefined);
    await fs.rm(rootPath, { recursive: true, force: true });
  });

  it('lists every folder parents first, from metadata alone', async () => {
    await write('a.md', '# A');
    await write('notes/b.md', '# Bee');
    await write('notes/deep/c.md', '# C');
    await write('.git/config');
    await write('node_modules/pkg/index.js');
    await write('report_files/report.md');
    await write('_squisq/runtime.js');
    const { entries } = await collect(open());

    expect(entries.map((entry) => entry.path)).to.deep.equal([
      '_squisq',
      'a.md',
      'notes',
      'report_files',
      'notes/b.md',
      'notes/deep',
      'notes/deep/c.md',
    ]);
    const bee = entries.find((entry) => entry.path === 'notes/b.md');
    expect(bee).to.include({ kind: 'file', name: 'b.md', size: 5 });
    expect(String(bee?.version)).to.match(/^meta:f:/);
    expect(entries.find((entry) => entry.path === 'notes')).to.include({
      kind: 'directory',
      size: null,
    });
    expect(opened).to.deep.equal([]);
  });

  it('reports online-only files without reading them', async () => {
    await write('cloud.md', '# In the cloud');
    await write('local.md', '# Here');
    const { entries } = await collect(
      open({ isOnlineOnly: (stat) => Number(stat.size) === '# In the cloud'.length }),
    );
    expect(entries.find((entry) => entry.path === 'cloud.md')).to.include({ onlineOnly: true });
    expect(entries.find((entry) => entry.path === 'local.md')).to.not.have.property('onlineOnly');
    expect(opened).to.deep.equal([]);
  });

  it('moves its version when a file changes and keeps it otherwise', async () => {
    await write('a.md', 'one');
    const first = (await collect(open())).entries[0]?.version;
    expect((await collect(provider!)).entries[0]?.version).to.equal(first);
    await write('a.md', 'one and more');
    expect((await collect(provider!)).entries[0]?.version).to.not.equal(first);
  });

  it('pages a folder larger than the per-listing entry limit', async () => {
    const big = path.join(rootPath, 'big');
    await fs.mkdir(big);
    const names = Array.from({ length: 10_050 }, (_, n) => `n${String(n).padStart(5, '0')}.md`);
    for (let start = 0; start < names.length; start += 500) {
      await Promise.all(
        names.slice(start, start + 500).map((name) => fs.writeFile(path.join(big, name), '')),
      );
    }
    const listing = open();
    await listing
      .readDirectory(p('big'))
      .then(() => expect.fail('readDirectory should refuse the folder'))
      .catch((error: unknown) => expect((error as FsError).code).to.equal('quota-exceeded'));
    const { pages, entries } = await collect(listing);
    expect(entries).to.have.length(10_051);
    expect(pages.length).to.be.greaterThan(5);
    for (const page of pages)
      expect(page.entries.length + page.unreadable.length).to.be.at.most(2_000);
  });

  it('reports a folder it cannot read and keeps going', async function () {
    if (process.platform === 'win32' || process.getuid?.() === 0) this.skip();
    await write('locked/secret.md');
    await write('open/visible.md');
    await fs.chmod(path.join(rootPath, 'locked'), 0o000);
    const { pages, entries } = await collect(open());
    expect(pages.flatMap((page) => page.unreadable)).to.deep.equal(['locked']);
    expect(entries.map((entry) => entry.path)).to.include('open/visible.md');
    expect(entries.map((entry) => entry.path)).to.not.include('locked/secret.md');
  });

  it('follows links only inside the workspace and never loops', async function () {
    if (process.platform === 'win32') this.skip();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'docblocks-enumerate-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'private.md'), 'outside');
      await write('inside/a.md');
      await fs.symlink(outside, path.join(rootPath, 'escape'));
      await fs.symlink(path.join(rootPath, 'inside'), path.join(rootPath, 'inside', 'loop'));
      const { entries } = await collect(open());
      const paths = entries.map((entry) => entry.path);
      expect(paths).to.not.include('escape');
      expect(paths.some((entry) => entry.includes('private.md'))).to.equal(false);
      expect(paths.filter((entry) => entry.endsWith('a.md')).length).to.be.at.most(2);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('lists a subfolder and refuses a missing or file root', async () => {
    await write('notes/b.md');
    await write('notes/deep/c.md');
    const listing = open();
    expect((await collect(listing, 'notes')).entries.map((entry) => entry.path)).to.deep.equal([
      'notes/b.md',
      'notes/deep',
      'notes/deep/c.md',
    ]);
    for (const [folder, code] of [
      ['missing', 'not-found'],
      ['notes/b.md', 'type-mismatch'],
    ] as const) {
      const failure = await collect(listing, folder).catch((error: unknown) => error);
      expect(failure).to.be.instanceOf(FsError);
      expect((failure as FsError).code).to.equal(code);
    }
  });

  it('gives an empty folder one empty page', async () => {
    const { pages } = await collect(open());
    expect(pages).to.deep.equal([{ entries: [], unreadable: [] }]);
  });
});
