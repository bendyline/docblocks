import { expect } from 'chai';
import { MemoryFileSystemProvider } from '@bendyline/docblocks/filesystem';

describe('MemoryFileSystemProvider', () => {
  let fs: MemoryFileSystemProvider;

  beforeEach(() => {
    fs = new MemoryFileSystemProvider('mem-1', 'Memory');
  });

  it('exposes id and label', () => {
    expect(fs.id).to.equal('mem-1');
    expect(fs.label).to.equal('Memory');
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
    // readFile on a binary entry is null; readBinary on a text entry is null.
    expect(await fs.readFile('/img/a.png')).to.equal(null);
    await fs.writeFile('/t.md', 'x');
    expect(await fs.readBinary('/t.md')).to.equal(null);
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
});
