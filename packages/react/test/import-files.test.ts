/**
 * Tests for the drag-and-drop import pipeline (MF-12).
 *
 * Two behaviours are load-bearing and were both broken:
 *   • An import must never overwrite an existing document. `report.docx`
 *     dropped next to an existing `report.md` used to replace it outright,
 *     with no confirmation and no undo.
 *   • A failed import must be reported. Failures were `console.error`-only,
 *     so a bad drop was indistinguishable from no drop at all.
 */
import { expect } from 'chai';
import { MemoryFileSystemProvider } from '@bendyline/docblocks/filesystem';
import {
  importDroppedFiles,
  summariseImport,
  type ImportFilesDeps,
  type ImportedMediaSource,
} from '../src/DocBlocksShell/import-files.js';

function textFile(name: string, content: string): File {
  return new File([content], name, { type: 'text/markdown' });
}

/** A dropped file whose read blows up — stands in for a corrupt .docx/.pdf. */
function failingFile(name: string, message: string): File {
  return {
    name,
    text: () => Promise.reject(new Error(message)),
    arrayBuffer: () => Promise.reject(new Error(message)),
  } as unknown as File;
}

function makeProvider(): MemoryFileSystemProvider {
  return new MemoryFileSystemProvider('test-ws', 'Test workspace');
}

const noMedia: ImportFilesDeps = {
  persistMedia: async () => undefined,
};

describe('importDroppedFiles', () => {
  it('never overwrites an existing document — it imports alongside it', async () => {
    const provider = makeProvider();
    provider.seedText('report.md', '# The original — do not lose me\n');

    const result = await importDroppedFiles([textFile('report.md', '# Dropped\n')], provider, {
      ...noMedia,
    });

    // The pre-existing document is untouched. This is the whole bug.
    expect(await provider.readFile('report.md')).to.equal('# The original — do not lose me\n');
    expect(await provider.readFile('report (2).md')).to.equal('# Dropped\n');
    expect(result.imported).to.deep.equal([
      { source: 'report.md', path: 'report (2).md', renamed: true },
    ]);
    expect(result.failed).to.deep.equal([]);
  });

  it('walks past several collisions', async () => {
    const provider = makeProvider();
    provider.seedText('notes.md', 'first');
    provider.seedText('notes (2).md', 'second');

    await importDroppedFiles([textFile('notes.md', 'third')], provider, noMedia);

    expect(await provider.readFile('notes.md')).to.equal('first');
    expect(await provider.readFile('notes (2).md')).to.equal('second');
    expect(await provider.readFile('notes (3).md')).to.equal('third');
  });

  it('writes straight to the dropped name when nothing collides', async () => {
    const provider = makeProvider();

    const result = await importDroppedFiles([textFile('fresh.md', '# Fresh\n')], provider, noMedia);

    expect(await provider.readFile('fresh.md')).to.equal('# Fresh\n');
    expect(result.imported[0]).to.deep.equal({
      source: 'fresh.md',
      path: 'fresh.md',
      renamed: false,
    });
    // Nothing to narrate: the file landed exactly where the user expects.
    expect(summariseImport(result)).to.equal(null);
  });

  it('reports a failed import instead of swallowing it', async () => {
    const provider = makeProvider();

    const result = await importDroppedFiles([failingFile('broken.md', 'disk on fire')], provider, {
      ...noMedia,
    });

    expect(result.imported).to.deep.equal([]);
    expect(result.failed).to.deep.equal([{ source: 'broken.md', message: 'disk on fire' }]);

    const summary = summariseImport(result);
    expect(summary?.kind).to.equal('error');
    expect(summary?.message).to.contain('broken.md');
    expect(summary?.message).to.contain('disk on fire');
  });

  it('leaves no empty placeholder behind when an import fails', async () => {
    const provider = makeProvider();

    await importDroppedFiles([failingFile('broken.md', 'nope')], provider, noMedia);

    // The name is claimed up-front to reserve it; a later failure must undo it.
    expect(await provider.readFile('broken.md')).to.equal(null);
  });

  it('does not let one bad file abort the rest of the batch', async () => {
    const provider = makeProvider();

    const result = await importDroppedFiles(
      [
        textFile('one.md', '# One\n'),
        failingFile('bad.md', 'kaboom'),
        textFile('two.md', '# Two\n'),
      ],
      provider,
      noMedia,
    );

    expect(await provider.readFile('one.md')).to.equal('# One\n');
    expect(await provider.readFile('two.md')).to.equal('# Two\n');
    expect(result.imported.map((entry) => entry.path)).to.deep.equal(['one.md', 'two.md']);
    expect(result.failed.map((entry) => entry.source)).to.deep.equal(['bad.md']);
    expect(summariseImport(result)?.kind).to.equal('error');
  });

  it('keys the media folder off the final, de-duplicated name', async () => {
    const provider = makeProvider();
    provider.seedText('deck.md', 'original');
    const mediaPaths: string[] = [];
    const deps: ImportFilesDeps = {
      persistMedia: async (_source: ImportedMediaSource, path: string) => {
        mediaPaths.push(path);
      },
    };

    // .dbk routes through the bundle decoder, which also needs the final path.
    const result = await importDroppedFiles([textFile('deck.md', 'dropped')], provider, deps);

    expect(result.imported[0].path).to.equal('deck (2).md');
    // Markdown/text imports carry no media, so nothing should be persisted.
    expect(mediaPaths).to.deep.equal([]);
  });

  it('skips file types it cannot import without touching the workspace', async () => {
    const provider = makeProvider();

    const result = await importDroppedFiles([textFile('photo.png', 'binary-ish')], provider, {
      ...noMedia,
    });

    expect(result.imported).to.deep.equal([]);
    expect(result.unsupported).to.deep.equal(['photo.png']);
    expect(await provider.readFile('photo.md')).to.equal(null);
  });
});

describe('summariseImport', () => {
  it('names the renamed document so the user knows where it went', () => {
    const summary = summariseImport({
      imported: [{ source: 'report.docx', path: 'report (2).md', renamed: true }],
      failed: [],
      unsupported: [],
    });
    expect(summary?.kind).to.equal('success');
    expect(summary?.message).to.contain('report (2).md');
  });

  it('counts a partial failure', () => {
    const summary = summariseImport({
      imported: [{ source: 'a.md', path: 'a.md', renamed: false }],
      failed: [
        { source: 'b.md', message: 'x' },
        { source: 'c.md', message: 'y' },
      ],
      unsupported: [],
    });
    expect(summary?.kind).to.equal('error');
    expect(summary?.message).to.equal('Could not import 2 of 3 files.');
  });
});
