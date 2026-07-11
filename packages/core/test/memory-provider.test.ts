import { expect } from 'chai';
import {
  FsError,
  LegacyFileSystemProviderV2Adapter,
  MemoryFileSystemProvider,
  MemoryFileSystemProviderV2,
  getFileSystemProviderV2,
  parseWorkspacePath,
  type FileSystemWatchEvent,
} from '../src/filesystem/index.js';

describe('MemoryFileSystemProvider', () => {
  let fs: MemoryFileSystemProvider;

  beforeEach(() => {
    fs = new MemoryFileSystemProvider('mem-1', 'Memory');
  });

  it('exposes id and label', () => {
    expect(fs.id).to.equal('mem-1');
    expect(fs.label).to.equal('Memory');
  });

  it('uses direct v2 storage as authority while keeping the v1 facade coherent', async () => {
    expect(fs.v2).to.be.instanceOf(MemoryFileSystemProviderV2);
    expect(fs.v2).not.to.be.instanceOf(LegacyFileSystemProviderV2Adapter);
    expect(getFileSystemProviderV2(fs)).to.equal(fs.v2);
    const path = parseWorkspacePath('/note.md');

    await fs.writeFile('/note.md', 'legacy');
    expect(new TextDecoder().decode((await fs.v2.readFile(path))!.data)).to.equal('legacy');

    await fs.v2.writeFile(path, new TextEncoder().encode('revisioned'), {
      mode: 'replace',
      expectedVersion: (await fs.v2.stat(path))!.version,
    });
    expect(await fs.readFile('/note.md')).to.equal('revisioned');
    expect(fs.captureContents().files[0]).to.deep.equal({
      kind: 'text',
      path: 'note.md',
      content: 'revisioned',
    });
  });

  it('keeps compatibility payload kind coupled to the bytes read', async () => {
    await fs.writeFile('/race.dat', 'text baseline');

    const textReadAsBinary = fs.readBinary('/race.dat');
    await fs.writeBinary('/race.dat', new Uint8Array([9, 8, 7]));

    expect(await textReadAsBinary).to.equal(null);
    expect([...new Uint8Array((await fs.readBinary('/race.dat'))!)]).to.deep.equal([9, 8, 7]);
  });

  it('serializes concurrent legacy compare-and-write attempts over v2 authority', async () => {
    await fs.writeFile('/contended.md', 'baseline');

    const [first, second] = await Promise.all([
      fs.commitFile('/contended.md', 'first', 'baseline'),
      fs.commitFile('/contended.md', 'second', 'baseline'),
    ]);

    expect([first.status, second.status].sort()).to.deep.equal(['committed', 'conflict']);
    expect(await fs.readFile('/contended.md')).to.equal('first');
    expect(
      new TextDecoder().decode((await fs.v2.readFile(parseWorkspacePath('/contended.md')))!.data),
    ).to.equal('first');
  });

  it('round-trips a text file (slash-prefixed and bare paths are equivalent)', async () => {
    await fs.writeFile('/notes.md', '# Hello');
    expect(await fs.readFile('/notes.md')).to.equal('# Hello');
    expect(await fs.readFile('notes.md')).to.equal('# Hello');
  });

  it('readFile returns null for a missing file', async () => {
    expect(await fs.readFile('/nope.md')).to.equal(null);
  });

  it('seedText makes a file readable', async () => {
    fs.seedText('/seeded.md', 'seed');
    expect(await fs.readFile('/seeded.md')).to.equal('seed');
    expect(await fs.exists('/seeded.md')).to.equal(true);
  });

  it('round-trips binary content and stores an independent copy', async () => {
    const src = new Uint8Array([1, 2, 3, 4]);
    await fs.writeBinary('/img/a.png', src);
    // Mutating the source must not affect stored bytes.
    src[0] = 99;
    const out = await fs.readBinary('/img/a.png');
    expect(out).to.be.instanceOf(ArrayBuffer);
    expect([...new Uint8Array(out!)]).to.deep.equal([1, 2, 3, 4]);
    // Mutating a returned buffer must not bypass treeVersion or alter storage.
    new Uint8Array(out!)[1] = 99;
    expect([...new Uint8Array((await fs.readBinary('/img/a.png'))!)]).to.deep.equal([1, 2, 3, 4]);
    // The v1 text API decodes binary-authoritative entries for the v2 migration adapter.
    expect(await fs.readFile('/img/a.png')).to.equal(
      new TextDecoder().decode(new Uint8Array([1, 2, 3, 4])),
    );
    await fs.writeFile('/t.md', 'x');
    expect(await fs.readBinary('/t.md')).to.equal(null);
  });

  it('atomically replaces the complete tree and removes stale entries', async () => {
    await fs.writeFile('/old.md', 'old');
    await fs.writeBinary('/old_files/stale.png', new Uint8Array([9]));
    await fs.createDirectory('/empty');

    const nextBinary = new Uint8Array([1, 2, 3]);
    fs.replaceContents({
      files: [
        { kind: 'text', path: '/new.md', content: 'new' },
        { kind: 'binary', path: '/new_files/image.png', data: nextBinary },
      ],
    });
    nextBinary[0] = 99;

    expect(await fs.exists('/old.md')).to.equal(false);
    expect(await fs.exists('/old_files/stale.png')).to.equal(false);
    expect(await fs.exists('/empty')).to.equal(false);
    expect(await fs.readFile('/new.md')).to.equal('new');
    expect([...new Uint8Array((await fs.readBinary('/new_files/image.png'))!)]).to.deep.equal([
      1, 2, 3,
    ]);
  });

  it('rolls back a whole-tree replacement that fails validation', async () => {
    await fs.writeFile('/keep.md', 'original');
    await fs.writeBinary('/keep_files/image.png', new Uint8Array([4, 5]));

    expect(() =>
      fs.replaceContents({
        files: [
          { kind: 'text', path: '/next.md', content: 'next' },
          { kind: 'binary', path: '/collision/data.bin', data: new Uint8Array([1]) },
          { kind: 'text', path: '/collision', content: 'not a directory' },
        ],
      }),
    )
      .to.throw(FsError)
      .with.property('code', 'type-mismatch');

    expect(await fs.readFile('/keep.md')).to.equal('original');
    expect([...new Uint8Array((await fs.readBinary('/keep_files/image.png'))!)]).to.deep.equal([
      4, 5,
    ]);
    expect(await fs.exists('/next.md')).to.equal(false);
    expect(await fs.exists('/collision')).to.equal(false);
  });

  it('rolls back replacement on stale whole-tree CAS without emitting overflow', async () => {
    await fs.writeFile('/keep.md', 'baseline');
    const expectedRevision = fs.treeVersion;
    await fs.writeFile('/keep.md', 'newer local');
    const events: FileSystemWatchEvent[] = [];
    const subscription = fs.v2.watch((event) => events.push(event));
    await subscription.ready;

    expect(() =>
      fs.replaceContents(
        { files: [{ kind: 'text', path: '/replacement.md', content: 'replacement' }] },
        expectedRevision,
      ),
    )
      .to.throw(FsError)
      .with.property('code', 'conflict');
    expect(await fs.readFile('/keep.md')).to.equal('newer local');
    expect(await fs.exists('/replacement.md')).to.equal(false);
    expect(events).to.deep.equal([]);
    await subscription.dispose();
  });

  it('accepts explicit nested directories independent of replacement order', async () => {
    fs.replaceContents({ files: [], directories: ['/one/two', '/one'] });

    expect(await fs.exists('/one')).to.equal(true);
    expect(await fs.exists('/one/two')).to.equal(true);
  });

  it('captures an owned deterministic copy of its contents', async () => {
    await fs.writeBinary('/z.bin', new Uint8Array([7, 8]));
    await fs.writeFile('/a.md', 'a');

    const snapshot = fs.captureContents();
    expect(snapshot.files.map((file) => file.path)).to.deep.equal(['a.md', 'z.bin']);
    const binary = snapshot.files.find((file) => file.kind === 'binary');
    expect(binary?.kind).to.equal('binary');
    if (binary?.kind === 'binary') new Uint8Array(binary.data)[0] = 0;

    expect([...new Uint8Array((await fs.readBinary('/z.bin'))!)]).to.deep.equal([7, 8]);
  });

  it('restores parents for explicitly empty nested directories', async () => {
    fs.replaceContents({ files: [], directories: ['/one/two'] });

    expect(await fs.exists('/one')).to.equal(true);
    expect(await fs.exists('/one/two')).to.equal(true);
    expect((await fs.readDirectory('/')).map((entry) => entry.path)).to.deep.equal(['one']);
  });

  it('stat reports name, path, and byte size', async () => {
    await fs.writeFile('/a/b.md', 'abcde');
    const meta = await fs.stat('/a/b.md');
    expect(meta).to.not.equal(null);
    expect(meta!.name).to.equal('b.md');
    expect(meta!.path).to.equal('a/b.md');
    expect(meta!.size).to.equal(5);
    expect(await fs.stat('/missing.md')).to.equal(null);
  });

  it('readDirectory returns immediate children, directories first', async () => {
    await fs.writeFile('/readme.md', '1');
    await fs.writeFile('/notes/day1.md', '2');
    await fs.writeFile('/notes/img/pic.png', '3');
    await fs.writeFile('/apple.md', '4');

    const root = await fs.readDirectory('/');
    expect(root.map((e) => `${e.kind}:${e.name}`)).to.deep.equal([
      'directory:notes',
      'file:apple.md',
      'file:readme.md',
    ]);

    const notes = await fs.readDirectory('/notes');
    expect(notes.map((e) => `${e.kind}:${e.name}`)).to.deep.equal([
      'directory:img',
      'file:day1.md',
    ]);
    expect(notes.find((e) => e.kind === 'directory')!.path).to.equal('notes/img');
  });

  it('createDirectory adds an empty listable directory', async () => {
    await fs.createDirectory('/empty');
    expect(await fs.exists('/empty')).to.equal(true);
    expect(await fs.readDirectory('/empty')).to.deep.equal([]);
  });

  it('delete removes a file, and a directory removes its subtree', async () => {
    await fs.writeFile('/keep.md', '1');
    await fs.writeFile('/dir/a.md', '2');
    await fs.writeFile('/dir/sub/b.md', '3');

    await fs.delete('/dir/a.md');
    expect(await fs.exists('/dir/a.md')).to.equal(false);

    await fs.delete('/dir');
    expect(await fs.exists('/dir')).to.equal(false);
    expect(await fs.exists('/dir/sub/b.md')).to.equal(false);
    expect(await fs.readFile('/keep.md')).to.equal('1');
  });

  it('renames a file', async () => {
    await fs.writeFile('/old.md', 'hi');
    await fs.rename('/old.md', '/new.md');
    expect(await fs.readFile('/old.md')).to.equal(null);
    expect(await fs.readFile('/new.md')).to.equal('hi');
    expect((await fs.stat('/new.md'))!.name).to.equal('new.md');
  });

  it('renames a directory and moves its children', async () => {
    await fs.writeFile('/src/a.md', '1');
    await fs.writeFile('/src/deep/b.md', '2');
    await fs.rename('/src', '/dst');
    expect(await fs.readFile('/dst/a.md')).to.equal('1');
    expect(await fs.readFile('/dst/deep/b.md')).to.equal('2');
    expect(await fs.exists('/src')).to.equal(false);
  });

  it('rejects moving a directory into itself', async () => {
    await fs.writeFile('/a/x.md', '1');
    let threw = false;
    try {
      await fs.rename('/a', '/a/b');
    } catch {
      threw = true;
    }
    expect(threw).to.equal(true);
  });

  it('rejects missing sources and existing destinations', async () => {
    await fs.writeFile('/source.md', 'source');
    await fs.writeFile('/target.md', 'target');

    for (const [from, to] of [
      ['/missing.md', '/new.md'],
      ['/source.md', '/target.md'],
    ]) {
      let threw = false;
      try {
        await fs.rename(from, to);
      } catch {
        threw = true;
      }
      expect(threw).to.equal(true);
    }

    expect(await fs.readFile('/source.md')).to.equal('source');
    expect(await fs.readFile('/target.md')).to.equal('target');
  });

  it('makes v2 disposal final for every v1 facade operation', async () => {
    const subscription = fs.v2.watch(() => undefined);
    await subscription.ready;
    await fs.v2.dispose();
    await fs.v2.dispose();

    expect(subscription.closed).to.equal(true);
    let failure: unknown;
    try {
      await fs.writeFile('/after-dispose.md', 'nope');
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(FsError);
    expect((failure as FsError).code).to.equal('disposed');
    expect(() => fs.replaceContents({ files: [] }))
      .to.throw(FsError)
      .with.property('code', 'disposed');
  });
});
