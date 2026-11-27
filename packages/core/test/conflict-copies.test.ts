import { readFileSync } from 'node:fs';
import { expect } from 'chai';
import {
  CONFLICT_COPIES_DIRECTORY_NAME,
  PREMERGE_COPY_LIFETIME_MS,
  PREMERGE_COPY_LIMIT,
  conflictCopyHash,
  conflictCopyScope,
  formatConflictCopyName,
  isConflictCopyPath,
  isReviewableConflictCopy,
  listConflictCopies,
  parseConflictCopyName,
  pruneConflictCopies,
  readConflictCopy,
  removeConflictCopy,
  sanitizeConflictCopyLabel,
  writeConflictCopy,
  type ConflictCopyOrigin,
} from '../src/filesystem/conflict-copies.js';
import { MemoryFileSystemProvider } from '../src/filesystem/memory-provider.js';

interface NameVector {
  name: string;
  capturedAt: string;
  origin: ConflictCopyOrigin;
  source: boolean;
  hash: string;
  label: string | null;
  extension: string;
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/conflict-copy-names.json', import.meta.url), 'utf8'),
) as {
  names: NameVector[];
  rejected: string[];
  labels: Array<{ input: string; output: string | null }>;
  hashes: Array<{ text: string; hash: string }>;
};

const AT = Date.UTC(2026, 10, 20, 10, 36, 12);

describe('conflict copy names', () => {
  it('formats and parses every shared vector the same way', () => {
    for (const vector of fixture.names) {
      const parsed = {
        capturedAt: Date.parse(vector.capturedAt),
        origin: vector.origin,
        source: vector.source,
        hash: vector.hash,
        label: vector.label,
        extension: vector.extension,
      };
      expect(formatConflictCopyName(parsed), vector.name).to.equal(vector.name);
      expect(parseConflictCopyName(vector.name), vector.name).to.deep.equal(parsed);
    }
  });

  it('rejects anything that is not a conflict copy', () => {
    for (const name of fixture.rejected) {
      expect(parseConflictCopyName(name), name).to.equal(null);
    }
  });

  it('makes device names safe inside a file name', () => {
    for (const { input, output } of fixture.labels) {
      expect(sanitizeConflictCopyLabel(input), JSON.stringify(input)).to.equal(output);
    }
  });

  it('hashes content the way the native storage layers do', () => {
    for (const { text, hash } of fixture.hashes) {
      expect(conflictCopyHash(text)).to.equal(hash);
      expect(conflictCopyHash(new TextEncoder().encode(text))).to.equal(hash);
    }
  });

  it('never formats a name it could not parse back', () => {
    expect(() =>
      formatConflictCopyName({
        capturedAt: AT,
        origin: 'sync',
        source: false,
        hash: 'nope',
        label: null,
        extension: '.md',
      }),
    ).to.throw(TypeError);
    expect(() =>
      formatConflictCopyName({
        capturedAt: AT,
        origin: 'sync',
        source: false,
        hash: '0123456789abcdef',
        label: null,
        extension: '.m d',
      }),
    ).to.throw(TypeError);
  });
});

describe('conflict copy scope', () => {
  it('puts a Markdown document’s copies in its sidecar', () => {
    expect(conflictCopyScope('Notes/Unicorns.md')).to.deep.equal({
      directory: 'Notes/Unicorns_files/conflicts',
      source: false,
      extension: '.md',
    });
    expect(conflictCopyScope('/Unicorns.markdown')).to.deep.equal({
      directory: '/Unicorns_files/conflicts',
      source: false,
      extension: '.markdown',
    });
  });

  it('marks the copies of an outside-in source', () => {
    const expected = { directory: 'Site/Page_files/conflicts', source: true, extension: '.md' };
    expect(conflictCopyScope('Site/Page.html', 'Site/Page_files/page.md')).to.deep.equal(expected);
    // The same source opened directly resolves to the same place.
    expect(conflictCopyScope('Site/Page_files/page.md')).to.deep.equal(expected);
  });

  it('offers no sidecar for files that keep none', () => {
    expect(conflictCopyScope('data.json')).to.equal(null);
    expect(conflictCopyScope('page.html')).to.equal(null);
    expect(conflictCopyScope('page.html', 'page.html')).to.equal(null);
  });
});

describe('conflict copy paths', () => {
  it('recognises a sidecar’s conflicts folder and everything in it', () => {
    for (const path of [
      'Notes/Unicorns_files/conflicts',
      '/Notes/Unicorns_files/conflicts/20261120T103612Z-sync-0123456789abcdef.md',
      'Unicorns_files/conflicts/other/photo.png',
      'Unicorns_files\\conflicts\\.gitignore',
    ]) {
      expect(isConflictCopyPath(path), path).to.equal(true);
    }
    for (const path of [
      'Notes/Unicorns_files/photo.png',
      'Notes/conflicts/Unicorns.md',
      'Unicorns_files/audio/conflicts.mp3',
      'conflicts',
    ]) {
      expect(isConflictCopyPath(path), path).to.equal(false);
    }
  });
});

describe('conflict copies on disk', () => {
  const scope = conflictCopyScope('Notes/Unicorns.md')!;

  async function workspace(): Promise<MemoryFileSystemProvider> {
    const fs = new MemoryFileSystemProvider('conflict-copies', 'Conflict copies');
    await fs.writeFile('Notes/Unicorns.md', 'current');
    return fs;
  }

  it('lists nothing for a document with no copies', async () => {
    const fs = await workspace();
    expect(await listConflictCopies(fs, scope)).to.deep.equal([]);
    await fs.v2.dispose();
  });

  it('keeps a version once, newest first, with git told to ignore the folder', async () => {
    const fs = await workspace();
    await fs.writeFile('.git/HEAD', 'ref: refs/heads/main');
    const first = await writeConflictCopy(fs, scope, 'from the Mac', {
      origin: 'sync',
      label: "Mike's MacBook Pro",
      capturedAt: AT,
      currentContent: 'current',
    });
    const second = await writeConflictCopy(fs, scope, 'from this phone', {
      origin: 'local',
      capturedAt: AT + 60_000,
      currentContent: 'current',
    });
    expect(first.status).to.equal('written');
    expect(second.status).to.equal('written');
    expect(first.copy!.name).to.equal(
      `20261120T103612Z-sync-${conflictCopyHash('from the Mac')} (Mike's MacBook Pro).md`,
    );

    const copies = await listConflictCopies(fs, scope);
    expect(copies.map((copy) => copy.origin)).to.deep.equal(['local', 'sync']);
    expect(copies[1]!.path).to.equal(`Notes/Unicorns_files/conflicts/${first.copy!.name}`);
    expect(await readConflictCopy(fs, copies[1]!)).to.equal('from the Mac');
    expect(
      await fs.readFile(`Notes/Unicorns_files/${CONFLICT_COPIES_DIRECTORY_NAME}/.gitignore`),
    ).to.equal('*\n');
    await fs.v2.dispose();
  });

  it('writes no .gitignore outside a git repository', async () => {
    // Two devices keeping a copy at the same moment would each create it:
    // one more conflict for a sync service, for a file only git reads.
    const fs = await workspace();
    await writeConflictCopy(fs, scope, 'other', { origin: 'sync', capturedAt: AT });
    const names = (await fs.readDirectory(scope.directory)).map((entry) => entry.name);
    expect(names).to.have.length(1);
    expect(names[0]).to.match(/-sync-[0-9a-f]{16}\.md$/);
    await fs.v2.dispose();
  });

  it('does not keep the same text twice, or a copy of the document itself', async () => {
    const fs = await workspace();
    const options = { origin: 'sync', capturedAt: AT, currentContent: 'current' } as const;
    const written = await writeConflictCopy(fs, scope, 'other', options);
    const again = await writeConflictCopy(fs, scope, 'other', {
      ...options,
      label: 'Another device',
      capturedAt: AT + 5_000,
    });
    const same = await writeConflictCopy(fs, scope, 'current', options);

    expect(again.status).to.equal('duplicate');
    expect(again.copy!.path).to.equal(written.copy!.path);
    expect(same).to.deep.equal({ status: 'same-as-document', copy: null });
    expect(await listConflictCopies(fs, scope)).to.have.length(1);
    await fs.v2.dispose();
  });

  it('keeps a copy for review even when the same text is only held for undo', async () => {
    const fs = await workspace();
    const undo = await writeConflictCopy(fs, scope, 'mine', { origin: 'premerge', capturedAt: AT });
    const review = await writeConflictCopy(fs, scope, 'mine', {
      origin: 'local',
      capturedAt: AT,
      currentContent: 'current',
    });
    expect(undo.status).to.equal('written');
    expect(review.status).to.equal('written');
    const copies = await listConflictCopies(fs, scope);
    expect(copies.filter(isReviewableConflictCopy).map((copy) => copy.origin)).to.deep.equal([
      'local',
    ]);
    await fs.v2.dispose();
  });

  it('keeps outside-in source copies apart from the document’s own', async () => {
    const fs = new MemoryFileSystemProvider('conflict-copies-source', 'Source');
    const page = conflictCopyScope('Page.html', 'Page_files/page.md')!;
    await writeConflictCopy(fs, page, 'source text', { origin: 'sync', capturedAt: AT });
    const copies = await listConflictCopies(fs, page);
    expect(copies).to.have.length(1);
    expect(copies[0]!.name).to.match(/-sync-s-[0-9a-f]{16}\.md$/);
    expect(await listConflictCopies(fs, { ...page, source: false })).to.deep.equal([]);
    await fs.v2.dispose();
  });

  it('removes the folder with the last copy and tolerates one that is already gone', async () => {
    const fs = await workspace();
    const a = await writeConflictCopy(fs, scope, 'a', { origin: 'sync', capturedAt: AT });
    const b = await writeConflictCopy(fs, scope, 'b', { origin: 'sync', capturedAt: AT });
    await removeConflictCopy(fs, scope, a.copy!);
    expect(await fs.exists(scope.directory)).to.equal(true);
    await removeConflictCopy(fs, scope, a.copy!);
    await removeConflictCopy(fs, scope, b.copy!);
    expect(await fs.exists(scope.directory)).to.equal(false);
    // The sidecar itself may hold media and history; it stays.
    await fs.writeBinary('Notes/Unicorns_files/photo.png', new Uint8Array([1]));
    const c = await writeConflictCopy(fs, scope, 'c', { origin: 'sync', capturedAt: AT });
    await removeConflictCopy(fs, scope, c.copy!);
    expect(await fs.exists('Notes/Unicorns_files/photo.png')).to.equal(true);
    await fs.v2.dispose();
  });

  it('leaves the folder while it still holds copies of other sidecar files', async () => {
    const fs = await workspace();
    const a = await writeConflictCopy(fs, scope, 'a', { origin: 'sync', capturedAt: AT });
    await fs.writeBinary(`${scope.directory}/other/photo.png`, new Uint8Array([1]));
    await removeConflictCopy(fs, scope, a.copy!);
    expect(await fs.exists(`${scope.directory}/other/photo.png`)).to.equal(true);
    await fs.v2.dispose();
  });

  it('expires undo copies after a week and nothing else', async () => {
    const fs = await workspace();
    await writeConflictCopy(fs, scope, 'undo', { origin: 'premerge', capturedAt: AT });
    await writeConflictCopy(fs, scope, 'review', { origin: 'sync', capturedAt: AT });
    expect(await pruneConflictCopies(fs, scope, AT + PREMERGE_COPY_LIFETIME_MS - 1_000)).to.equal(
      0,
    );
    expect(await pruneConflictCopies(fs, scope, AT + PREMERGE_COPY_LIFETIME_MS)).to.equal(1);
    expect((await listConflictCopies(fs, scope)).map((copy) => copy.origin)).to.deep.equal([
      'sync',
    ]);
    await fs.v2.dispose();
  });

  it('keeps only the newest undo copies once there are too many', async () => {
    const fs = await workspace();
    for (let index = 0; index < PREMERGE_COPY_LIMIT + 3; index += 1) {
      await writeConflictCopy(fs, scope, `undo ${index}`, {
        origin: 'premerge',
        capturedAt: AT + index * 1_000,
      });
    }
    await writeConflictCopy(fs, scope, 'review', { origin: 'sync', capturedAt: AT });
    expect(await pruneConflictCopies(fs, scope, AT + 60_000)).to.equal(3);
    const left = await listConflictCopies(fs, scope);
    const undo = left.filter((copy) => copy.origin === 'premerge');
    expect(undo).to.have.length(PREMERGE_COPY_LIMIT);
    // The three oldest went.
    expect(Math.min(...undo.map((copy) => copy.capturedAt))).to.equal(AT + 3_000);
    expect(left.filter((copy) => copy.origin === 'sync')).to.have.length(1);
    await fs.v2.dispose();
  });

  it('ignores files in the folder that are not copies', async () => {
    const fs = await workspace();
    await fs.writeFile(`${scope.directory}/notes.md`, 'stray');
    await fs.writeFile(`${scope.directory}/.gitignore`, '*\n');
    expect(await listConflictCopies(fs, scope)).to.deep.equal([]);
    await fs.v2.dispose();
  });
});
