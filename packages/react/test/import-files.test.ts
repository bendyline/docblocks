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
import { importDroppedFiles, summariseImport } from '../src/DocBlocksShell/import-files.js';

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

describe('importDroppedFiles', () => {
  it('never overwrites an existing document — it imports alongside it', async () => {
    const provider = makeProvider();
    provider.seedText('report.md', '# The original — do not lose me\n');

    const result = await importDroppedFiles([textFile('report.md', '# Dropped\n')], provider);

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

    await importDroppedFiles([textFile('notes.md', 'third')], provider);

    expect(await provider.readFile('notes.md')).to.equal('first');
    expect(await provider.readFile('notes (2).md')).to.equal('second');
    expect(await provider.readFile('notes (3).md')).to.equal('third');
  });

  it('writes straight to the dropped name when nothing collides', async () => {
    const provider = makeProvider();

    const result = await importDroppedFiles([textFile('fresh.md', '# Fresh\n')], provider);

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

    const result = await importDroppedFiles([failingFile('broken.md', 'disk on fire')], provider);

    expect(result.imported).to.deep.equal([]);
    expect(result.failed).to.deep.equal([{ source: 'broken.md', message: 'disk on fire' }]);

    const summary = summariseImport(result);
    expect(summary?.kind).to.equal('error');
    expect(summary?.message).to.contain('broken.md');
    expect(summary?.message).to.contain('disk on fire');
  });

  it('leaves no empty placeholder behind when an import fails', async () => {
    const provider = makeProvider();

    await importDroppedFiles([failingFile('broken.md', 'nope')], provider);

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
    );

    expect(await provider.readFile('one.md')).to.equal('# One\n');
    expect(await provider.readFile('two.md')).to.equal('# Two\n');
    expect(result.imported.map((entry) => entry.path)).to.deep.equal(['one.md', 'two.md']);
    expect(result.failed.map((entry) => entry.source)).to.deep.equal(['bad.md']);
    expect(summariseImport(result)?.kind).to.equal('error');
  });

  it('keys an outside-in companion off the final, de-duplicated rendered name', async () => {
    const provider = makeProvider();
    provider.seedText('deck.html', '<h1>Original</h1>');
    const result = await importDroppedFiles(
      [new File(['<h1>Dropped</h1>'], 'deck.html', { type: 'text/html' })],
      provider,
    );

    expect(result.imported[0].path).to.equal('deck (2).html');
    expect(await provider.readFile('deck (2)_files/deck-2.md')).to.contain('# Dropped');
  });

  it('copies browser-viewable images byte-for-byte under their original name', async () => {
    const provider = makeProvider();
    const bytes = new Uint8Array([137, 80, 78, 71]);

    const result = await importDroppedFiles(
      [new File([bytes], 'photo.png', { type: 'image/png' })],
      provider,
    );

    expect(result.imported).to.deep.equal([
      { source: 'photo.png', path: 'photo.png', renamed: false },
    ]);
    expect(new Uint8Array((await provider.readBinary('photo.png'))!)).to.deep.equal(bytes);
  });

  it('preserves common source and text files instead of flattening them to Markdown', async () => {
    const provider = makeProvider();

    const result = await importDroppedFiles(
      [new File(['{"enabled":true}\n'], 'settings.json', { type: 'application/json' })],
      provider,
    );

    expect(result.imported[0]).to.deep.equal({
      source: 'settings.json',
      path: 'settings.json',
      renamed: false,
    });
    expect(await provider.readFile('settings.json')).to.equal('{"enabled":true}\n');
  });

  it('accepts unfamiliar text and image extensions when the browser supplies their MIME type', async () => {
    const provider = makeProvider();
    const result = await importDroppedFiles(
      [
        new File(['plain text'], 'notes.customtext', { type: 'text/x-custom' }),
        new File([new Uint8Array([1, 2, 3])], 'art.customimage', { type: 'image/x-custom' }),
      ],
      provider,
    );

    expect(result.imported.map((entry) => entry.path)).to.deep.equal([
      'notes.customtext',
      'art.customimage',
    ]);
    expect(result.unsupported).to.deep.equal([]);
  });

  it('reports file types outside the broad import allowlist', async () => {
    const provider = makeProvider();

    const result = await importDroppedFiles(
      [new File([new Uint8Array([77, 90])], 'installer.exe', { type: 'application/x-msdownload' })],
      provider,
    );

    expect(result.imported).to.deep.equal([]);
    expect(result.unsupported).to.deep.equal(['installer.exe']);
    expect(summariseImport(result)?.message).to.contain('installer.exe');
    expect(await provider.readBinary('installer.exe')).to.equal(null);
  });

  it('keeps a rendered HTML import outside and creates its editable source inside', async () => {
    const provider = makeProvider();
    const result = await importDroppedFiles(
      [new File(['<h1>Battle of Britain</h1>'], 'battle-of-britain.html', { type: 'text/html' })],
      provider,
    );

    expect(result.failed).to.deep.equal([]);
    expect(result.imported[0]).to.deep.equal({
      source: 'battle-of-britain.html',
      path: 'battle-of-britain.html',
      renamed: false,
    });
    expect(await provider.readFile('battle-of-britain.html')).to.equal(
      '<h1>Battle of Britain</h1>',
    );
    expect(await provider.readFile('battle-of-britain_files/battle-of-britain.md')).to.contain(
      'squisq-output: ../battle-of-britain.html',
    );
  });

  it('prepares a dropped CSV for outside-in editing', async () => {
    const provider = makeProvider();
    const result = await importDroppedFiles(
      [new File(['Name,Count\nWidgets,2\n'], 'inventory.csv', { type: 'text/csv' })],
      provider,
    );

    expect(result.failed).to.deep.equal([]);
    expect(result.imported[0]).to.deep.equal({
      source: 'inventory.csv',
      path: 'inventory.csv',
      renamed: false,
    });
    expect(await provider.readFile('inventory.csv')).to.equal('Name,Count\nWidgets,2\n');
    const markdown = await provider.readFile('inventory_files/inventory.md');
    expect(markdown).to.contain('squisq-output: ../inventory.csv');
    expect(markdown).to.contain('squisq-output-format: csv');
    expect(markdown).to.contain('| Name');
    expect(markdown).to.contain('| Widgets');
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

  it('reports a rejected file even when the rest of the drop imported', () => {
    const summary = summariseImport({
      imported: [{ source: 'notes.md', path: 'notes.md', renamed: false }],
      failed: [],
      unsupported: ['installer.exe'],
    });
    expect(summary).to.deep.equal({
      kind: 'error',
      message: 'installer.exe is not a file type DocBlocks can import.',
    });
  });
});

/**
 * Build a real `.dbk`: a zipped container holding a primary Markdown document
 * plus secondary ones. Round-tripping through the same writer the export path
 * uses (`containerToZip`) keeps the fixture honest — a hand-rolled zip could
 * drift from what DocBlocks actually emits.
 */
async function dbkFile(
  name: string,
  entries: Record<string, string>,
  documentPath: string,
): Promise<File> {
  const [{ MemoryContentContainer }, { containerToZip }] = await Promise.all([
    import('@bendyline/squisq/storage'),
    import('@bendyline/squisq-formats/container'),
  ]);
  const container = new MemoryContentContainer();
  for (const [path, content] of Object.entries(entries)) {
    await container.writeFile(path, new TextEncoder().encode(content));
  }
  await container.setDocumentPath?.(documentPath);
  const blob = await containerToZip(container);
  return new File([await blob.arrayBuffer()], name);
}

describe('importDroppedFiles — .dbk bundles', () => {
  it('imports a bundle’s secondary documents, not just the primary', async () => {
    const provider = makeProvider();
    const file = await dbkFile(
      'bundle.dbk',
      {
        'main.md': '# Primary\n',
        'chapter-two.md': '# Chapter Two\n',
        'notes/aside.md': '# Aside\n',
      },
      'main.md',
    );

    const result = await importDroppedFiles([file], provider);

    expect(result.failed).to.deep.equal([]);
    expect(await provider.readFile('bundle.md')).to.equal('# Primary\n');

    // The whole point: the secondary documents survive the drop. Before this
    // fix only `documentContent` was written and these vanished silently,
    // while the import reported complete success.
    const listed = await provider.readDirectory('bundle_files');
    expect(listed.length, 'secondary documents must be imported').to.be.greaterThan(0);
  });
});
