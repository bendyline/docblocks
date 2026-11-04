import { expect } from 'chai';
import type { BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FsError, parseWorkspacePath } from '@bendyline/docblocks/filesystem';
import {
  NodeWorkspaceFileSystemV2,
  createConcurrencyLimit,
  isOnlineOnlyFile,
  type NodeWorkspaceReadableFile,
} from '../main/node-workspace-filesystem-v2.js';
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

  describe('online-only cloud placeholders', () => {
    const text = (read: { readonly data: ArrayBuffer } | null) =>
      new TextDecoder().decode(read?.data);

    async function nodeHandle(absolute: string): Promise<NodeWorkspaceReadableFile> {
      const handle = await fs.open(absolute, 'r');
      return {
        stat: () => handle.stat({ bigint: true }),
        readFile: () => handle.readFile(),
        close: () => handle.close(),
      };
    }

    /** Model `names` as dataless until a read downloads them, gated by `release`. */
    async function cloudWorkspace(names: readonly string[]) {
      const online = new Set<bigint>();
      for (const name of names) {
        await fs.writeFile(path.join(rootPath, name), `${name} bytes`);
        online.add((await fs.stat(path.join(rootPath, name), { bigint: true })).ino);
      }
      const opened: string[] = [];
      const downloading = new Set<string>();
      const gates = new Map<string, () => void>();
      const release = (name: string) => gates.get(name)?.();
      const options = {
        isOnlineOnly: (stat: BigIntStats) => online.has(stat.ino),
        openReadableFile: async (absolute: string): Promise<NodeWorkspaceReadableFile> => {
          const name = path.basename(absolute);
          opened.push(name);
          const handle = await nodeHandle(absolute);
          const { ino } = await handle.stat();
          if (!online.has(ino)) return handle;
          return {
            ...handle,
            readFile: async () => {
              downloading.add(name);
              await new Promise<void>((resolve) => gates.set(name, resolve));
              downloading.delete(name);
              online.delete(ino);
              return handle.readFile();
            },
          };
        },
      };
      return { options, online, opened, downloading, release };
    }

    async function until(predicate: () => boolean, label: string): Promise<void> {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`Timed out waiting for ${label}.`);
    }

    it('recognizes macOS dataless files by their missing blocks', () => {
      const stat = (size: bigint, blocks: bigint, file = true) =>
        ({ isFile: () => file, size, blocks }) as unknown as BigIntStats;
      expect(isOnlineOnlyFile(stat(10n, 0n), 'darwin')).to.equal(true);
      expect(isOnlineOnlyFile(stat(10n, 8n), 'darwin')).to.equal(false);
      expect(isOnlineOnlyFile(stat(0n, 0n), 'darwin')).to.equal(false);
      expect(isOnlineOnlyFile(stat(10n, 0n, false), 'darwin')).to.equal(false);
      expect(isOnlineOnlyFile(stat(10n, 0n), 'win32')).to.equal(false);
      expect(isOnlineOnlyFile(stat(10n, 0n), 'linux')).to.equal(false);
    });

    it('lists a placeholder without downloading it and keeps its version after eviction', async () => {
      await fs.writeFile(path.join(rootPath, 'local.md'), 'local');
      const cloud = await cloudWorkspace(['cloud.webm']);
      provider = new NodeWorkspaceFileSystemV2(id, 'Cloud', rootPath, roots, cloud.options);

      const listed = await provider.readDirectory(p(''));
      const placeholder = listed.find((entry) => entry.name === 'cloud.webm');
      expect(placeholder?.kind === 'file' && placeholder.onlineOnly).to.equal(true);
      expect(listed.find((entry) => entry.name === 'local.md')).to.not.have.property('onlineOnly');
      expect(cloud.opened).to.deep.equal(['local.md']);

      const reading = provider.readFile(p('cloud.webm'));
      await until(() => cloud.downloading.has('cloud.webm'), 'download');
      cloud.release('cloud.webm');
      const read = await reading;
      expect(text(read)).to.equal('cloud.webm bytes');
      expect(read?.entry).to.not.have.property('onlineOnly');
      expect(read?.entry.version).to.not.equal(placeholder?.version);

      // Evicted again: listed online-only, but with the content version it was read at.
      cloud.online.add((await fs.stat(path.join(rootPath, 'cloud.webm'), { bigint: true })).ino);
      const [evicted] = (await provider.readDirectory(p(''))).filter(
        (entry) => entry.name === 'cloud.webm',
      );
      expect(evicted?.kind === 'file' && evicted.onlineOnly).to.equal(true);
      expect(evicted?.version).to.equal(read?.entry.version);
    });

    it('downloads a placeholder without holding up the rest of the workspace', async () => {
      await fs.writeFile(path.join(rootPath, 'acy.md'), '# acy');
      const cloud = await cloudWorkspace(['camera.webm']);
      provider = new NodeWorkspaceFileSystemV2(id, 'Cloud', rootPath, roots, cloud.options);

      const video = provider.readFile(p('camera.webm'));
      await until(() => cloud.downloading.has('camera.webm'), 'download');
      // Opening a document and listing its folder finish mid-download.
      expect(text(await provider.readFile(p('acy.md')))).to.equal('# acy');
      expect((await provider.readDirectory(p(''))).map((entry) => entry.name)).to.include(
        'camera.webm',
      );
      expect(cloud.downloading.has('camera.webm')).to.equal(true);

      cloud.release('camera.webm');
      expect(text(await video)).to.equal('camera.webm bytes');
    });

    it('answers a stat without downloading, so the size check before a read never holds the workspace', async () => {
      await fs.writeFile(path.join(rootPath, 'acy.md'), '# acy');
      const cloud = await cloudWorkspace(['camera.webm']);
      provider = new NodeWorkspaceFileSystemV2(id, 'Cloud', rootPath, roots, cloud.options);

      // The renderer stats a file to choose an inline or a chunked read.
      const stat = await provider.stat(p('camera.webm'));
      expect(stat?.kind === 'file' && stat.onlineOnly).to.equal(true);
      expect(stat?.kind === 'file' && stat.size).to.equal('camera.webm bytes'.length);
      expect(cloud.opened).to.deep.equal([]);

      const video = provider.readFile(p('camera.webm'));
      await until(() => cloud.downloading.has('camera.webm'), 'download');
      expect((await provider.stat(p('camera.webm')))?.kind).to.equal('file');
      expect(text(await provider.readFile(p('acy.md')))).to.equal('# acy');

      cloud.release('camera.webm');
      expect(text(await video)).to.equal('camera.webm bytes');
    });

    it('removes and moves a placeholder at the version a stat or listing gave, without downloading it', async () => {
      const cloud = await cloudWorkspace(['old.webm', 'gone.webm']);
      provider = new NodeWorkspaceFileSystemV2(id, 'Cloud', rootPath, roots, cloud.options);

      const old = await provider.stat(p('old.webm'));
      await provider.move(p('old.webm'), p('new.webm'), { expectedVersion: old?.version });
      const gone = (await provider.readDirectory(p(''))).find(
        (entry) => entry.name === 'gone.webm',
      );
      await provider.remove(p('gone.webm'), { missing: 'error', expectedVersion: gone?.version });

      expect((await fs.readdir(rootPath)).sort()).to.deep.equal(['new.webm']);
      expect(cloud.opened).to.deep.equal([]);
    });

    it('downloads at most two large placeholders at a time, and never queues a document behind them', async () => {
      const videos = ['one.webm', 'two.webm', 'three.webm'];
      const videoBytes = 9 * 1024 * 1024;
      const cloud = await cloudWorkspace([...videos, 'acy.md', 'figure.png']);
      for (const name of videos) await fs.truncate(path.join(rootPath, name), videoBytes);
      provider = new NodeWorkspaceFileSystemV2(id, 'Cloud', rootPath, roots, cloud.options);

      const reads = videos.map((name) => provider!.readFile(p(name)));
      await until(() => cloud.downloading.size === 2, 'two video downloads');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(cloud.downloading.size).to.equal(2);
      const queued = videos.find((name) => !cloud.downloading.has(name))!;

      const document = provider.readFile(p('acy.md'));
      const image = provider.readFile(p('figure.png'));
      await until(
        () => cloud.downloading.has('acy.md') && cloud.downloading.has('figure.png'),
        'document and image downloads',
      );
      cloud.release('acy.md');
      cloud.release('figure.png');
      expect(text(await document)).to.equal('acy.md bytes');
      expect(text(await image)).to.equal('figure.png bytes');
      expect(cloud.downloading.has(queued)).to.equal(false);

      for (const name of videos.filter((video) => video !== queued)) cloud.release(name);
      await until(() => cloud.downloading.has(queued), 'queued video download');
      cloud.release(queued);
      expect((await Promise.all(reads)).map((read) => read?.data.byteLength)).to.deep.equal(
        videos.map(() => videoBytes),
      );
    });

    it('starts urgent queued downloads first, newest first', async () => {
      const limit = createConcurrencyLimit(1);
      const started: string[] = [];
      const gates = new Map<string, () => void>();
      const run = (name: string, urgent = false) =>
        limit(async () => {
          started.push(name);
          await new Promise<void>((resolve) => gates.set(name, resolve));
        }, urgent);

      const runs = [
        run('first'),
        run('video'),
        run('image'),
        run('acy.md', true),
        run('inotes.md', true),
      ];
      for (let count = 1; count <= runs.length; count += 1) {
        await until(() => started.length === count, `task ${count}`);
        gates.get(started[count - 1])?.();
      }
      await Promise.all(runs);
      expect(started).to.deep.equal(['first', 'inotes.md', 'acy.md', 'video', 'image']);
    });
  });
});
