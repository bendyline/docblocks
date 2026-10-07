import { expect } from 'chai';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FsError, parseWorkspacePath } from '@bendyline/docblocks/filesystem';
import { NodeWorkspaceFileSystemV2 } from '../main/node-workspace-filesystem-v2.js';
import { getWorkspaceRoots, type WorkspaceRoots } from '../main/workspace-roots.js';

const p = parseWorkspacePath;
const bytes = (value: string) => new TextEncoder().encode(value);

describe('native filesystem publication and browsing regressions', () => {
  let rootPath: string;
  let provider: NodeWorkspaceFileSystemV2 | undefined;
  const roots = getWorkspaceRoots();
  const id = 'node-regressions';
  beforeEach(async () => {
    rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'docblocks-native-regressions-'));
    roots.register(id, rootPath);
  });
  afterEach(async () => {
    await provider?.dispose();
    provider = undefined;
    roots.unregister(id);
    await fs.rm(rootPath, { recursive: true, force: true });
  });

  function racingRoots(
    destination: string,
    create: (absolute: string) => Promise<void>,
  ): WorkspaceRoots {
    let injected = false;
    return {
      ...roots,
      resolveMutation: async (root, relative) => {
        const absolute = await roots.resolveMutation(root, relative);
        if (relative === destination && !injected) {
          injected = true;
          await create(absolute);
        }
        return absolute;
      },
    };
  }

  for (const mode of ['bytes', 'stream', 'absence precondition'] as const) {
    it(`preserves an externally created file during ${mode} publication`, async () => {
      provider = new NodeWorkspaceFileSystemV2(
        id,
        'Race',
        rootPath,
        racingRoots('created.md', (absolute) => fs.writeFile(absolute, 'external', { flag: 'wx' })),
      );
      const options =
        mode === 'absence precondition'
          ? { expectedVersion: null }
          : { mode: 'create' as const, expectedVersion: null };
      async function* chunks() {
        yield bytes('local');
      }
      const failure = await (
        mode === 'stream'
          ? provider.writeStream(p('created.md'), chunks(), 5, options)
          : provider.writeFile(p('created.md'), bytes('local'), options)
      ).catch((error: unknown) => error);
      expect(failure).to.be.instanceOf(FsError);
      expect((failure as FsError).code).to.equal('already-exists');
      expect(await fs.readFile(path.join(rootPath, 'created.md'), 'utf8')).to.equal('external');
      expect((await fs.readdir(rootPath)).filter((name) => name.endsWith('.tmp'))).to.deep.equal(
        [],
      );
    });
  }

  for (const kind of ['file', 'directory'] as const) {
    it(`preserves a racing ${kind} destination during move`, async () => {
      const source = path.join(rootPath, 'source');
      if (kind === 'file') await fs.writeFile(source, 'source');
      else {
        await fs.mkdir(source);
        await fs.writeFile(path.join(source, 'note.md'), 'source');
      }
      provider = new NodeWorkspaceFileSystemV2(
        id,
        'Move race',
        rootPath,
        racingRoots('destination', async (absolute) => {
          if (kind === 'file') await fs.writeFile(absolute, 'external', { flag: 'wx' });
          else await fs.mkdir(absolute);
        }),
      );
      const failure = await provider
        .move(p('source'), p('destination'))
        .catch((error: unknown) => error);
      expect(failure).to.be.instanceOf(FsError);
      expect((failure as FsError).code).to.equal('already-exists');
      if (kind === 'file')
        expect(await fs.readFile(path.join(rootPath, 'destination'), 'utf8')).to.equal('external');
      else expect(await fs.readdir(path.join(rootPath, 'destination'))).to.deep.equal([]);
      expect(
        await fs.readFile(kind === 'file' ? source : path.join(source, 'note.md'), 'utf8'),
      ).to.equal('source');
    });
  }

  it('lists collapsed directories and deletes a file without traversing an unrelated subtree', async () => {
    await fs.mkdir(path.join(rootPath, 'collapsed'));
    await fs.writeFile(path.join(rootPath, 'collapsed', 'a.md'), 'a');
    await fs.writeFile(path.join(rootPath, 'collapsed', 'b.md'), 'b');
    await fs.writeFile(path.join(rootPath, 'delete.md'), 'delete');
    let descendantOpens = 0;
    provider = new NodeWorkspaceFileSystemV2(id, 'Shallow listing', rootPath, roots, {
      traversalEntryLimit: 2,
      openReadableFile: async (absolute) => {
        if (absolute.includes(`${path.sep}collapsed${path.sep}`)) descendantOpens++;
        const handle = await fs.open(absolute, 'r');
        return {
          stat: () => handle.stat({ bigint: true }),
          readFile: () => handle.readFile(),
          close: () => handle.close(),
        };
      },
    });
    expect((await provider.stat(p('')))?.kind).to.equal('directory');
    expect((await provider.readDirectory(p(''))).map((entry) => entry.name)).to.have.members([
      'collapsed',
      'delete.md',
    ]);
    expect(descendantOpens).to.equal(0);
    expect((await provider.remove(p('delete.md'))).removed).to.equal(true);
    expect(await provider.stat(p('delete.md'))).to.equal(null);
    expect(descendantOpens).to.equal(0);
    // Explicit recursive snapshots remain bounded.
    const failure = await provider.snapshot().catch((error: unknown) => error);
    expect(failure).to.be.instanceOf(FsError);
    expect((failure as FsError).code).to.equal('quota-exceeded');
  });

  it('preserves both trees when another writer occupies a child during directory publication', async () => {
    await fs.mkdir(path.join(rootPath, 'source'));
    await fs.writeFile(path.join(rootPath, 'source', 'a.md'), 'first');
    await fs.writeFile(path.join(rootPath, 'source', 'b.md'), 'second');
    provider = new NodeWorkspaceFileSystemV2(
      id,
      'Child collision',
      rootPath,
      racingRoots('destination/b.md', (absolute) =>
        fs.writeFile(absolute, 'external', { flag: 'wx' }),
      ),
    );
    const failure = await provider
      .move(p('source'), p('destination'))
      .catch((error: unknown) => error);
    expect((failure as FsError).code).to.equal('already-exists');
    expect(await fs.readFile(path.join(rootPath, 'source', 'a.md'), 'utf8')).to.equal('first');
    expect(await fs.readFile(path.join(rootPath, 'source', 'b.md'), 'utf8')).to.equal('second');
    expect(await fs.readdir(path.join(rootPath, 'destination'))).to.deep.equal(['b.md']);
    expect(await fs.readFile(path.join(rootPath, 'destination', 'b.md'), 'utf8')).to.equal(
      'external',
    );
  });

  it('invalidates directory versions after observing a changed descendant', async () => {
    provider = new NodeWorkspaceFileSystemV2(id, 'Directory versions', rootPath, roots);
    await provider.writeFile(p('nested/note.md'), bytes('before'), { createParents: true });
    const before = await provider.stat(p('nested'));
    await fs.writeFile(path.join(rootPath, 'nested', 'note.md'), 'after');
    await provider.readFile(p('nested/note.md'));
    expect((await provider.stat(p('nested')))?.version).not.to.equal(before?.version);
    const failure = await provider
      .remove(p('nested'), { recursive: true, expectedVersion: before!.version })
      .catch((error: unknown) => error);
    expect((failure as FsError).code).to.equal('conflict');
    expect(await fs.readFile(path.join(rootPath, 'nested', 'note.md'), 'utf8')).to.equal('after');
  });
});
