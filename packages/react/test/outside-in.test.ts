import { expect } from 'chai';
import { MemoryFileSystemProvider } from '@bendyline/docblocks/filesystem';
import type { DocumentCommitRequest } from '@bendyline/docblocks/document';
import {
  createNewOutsideInDocument,
  createOutsideInDocumentTarget,
  enableOutsideInMarkdownEditing,
  loadEditableShellDocument,
} from '../src/DocBlocksShell/outside-in.js';

function request(
  targetKey: string,
  content: string,
  persistedContent: string,
): DocumentCommitRequest {
  return {
    targetKey,
    content,
    revision: 2,
    persistedRevision: 1,
    persistedContent,
    reason: 'manual',
  };
}

describe('DocBlocks outside-in editing', function () {
  this.timeout(30_000);

  it('creates an interactive Web page and keeps regenerating its player output', async () => {
    const provider = new MemoryFileSystemProvider('outside-interactive', 'Interactive');
    const created = await createNewOutsideInDocument(
      provider,
      '/demos/Flash cards.html',
      'interactive',
    );

    expect(created.sourcePath).to.equal('/demos/Flash cards_files/flash-cards.md');
    expect(created.content).to.contain('squisq-updatefrommarkdown: true');
    expect(created.content).to.contain('squisq-html-output: interactive');
    expect(await provider.readFile('/demos/Flash cards.html')).to.contain(
      '<script src="../_squisq/squisq-player.js"></script>',
    );
    expect(await provider.readFile('/demos/Flash cards.html')).to.contain('mode: "slideshow"');
    expect(await provider.readFile('/_squisq/squisq-player.js')).to.contain('SquisqPlayer');

    const target = createOutsideInDocumentTarget(provider, created.outsideIn);
    const next = created.content.replace('# Flash cards', '# Updated cards');
    await target.commit(request(target.key, next, created.content));
    expect(await provider.readFile('/demos/Flash cards.html')).to.contain('Updated cards');
  });

  it('creates a conventional static Web page and preserves that output on save', async () => {
    const provider = new MemoryFileSystemProvider('outside-static', 'Static');
    const created = await createNewOutsideInDocument(provider, '/guide.html', 'static');

    const initialHtml = await provider.readFile('/guide.html');
    expect(initialHtml).to.contain('<h1>guide</h1>');
    expect(initialHtml).not.to.contain('<script');
    expect(initialHtml).not.to.contain('data-squisq-doc');
    expect(await provider.readFile('/_squisq/squisq-player.js')).to.equal(null);

    await provider.writeBinary('/guide_files/hero.png', new Uint8Array([1, 2, 3]).buffer);
    const target = createOutsideInDocumentTarget(provider, created.outsideIn);
    const next = `${created.content}\n![Hero](hero.png)\n`;
    await target.commit(request(target.key, next, created.content));
    const updatedHtml = await provider.readFile('/guide.html');
    expect(updatedHtml).to.contain('src="guide_files/hero.png"');
    expect(updatedHtml).not.to.contain('<script');
  });

  it('creates DOCX, XLSX, and PDF files with editable Markdown companions', async () => {
    for (const extension of ['docx', 'xlsx', 'pdf'] as const) {
      const provider = new MemoryFileSystemProvider(`outside-${extension}`, extension);
      const created = await createNewOutsideInDocument(provider, `/Quarterly Report.${extension}`);
      const bytes = await provider.readBinary(`/Quarterly Report.${extension}`);

      expect(bytes, `${extension} target`).to.not.equal(null);
      expect(bytes!.byteLength, `${extension} target bytes`).to.be.greaterThan(100);
      expect(created.sourcePath).to.equal('/Quarterly Report_files/quarterly-report.md');
      expect(await provider.readFile(created.sourcePath)).to.contain(
        `squisq-output-format: ${extension}`,
      );
      expect(created.content).to.contain('squisq-updatefrommarkdown: true');

      const target = createOutsideInDocumentTarget(provider, created.outsideIn);
      const next = created.content.replace('# Quarterly Report', '# Updated Report');
      await target.commit(request(target.key, next, created.content));
      expect(await provider.readFile(created.sourcePath)).to.equal(next);
      await provider.v2.dispose();
    }
  });
  it('imports an HTML target once and reopens its durable companion Markdown', async () => {
    const provider = new MemoryFileSystemProvider('outside', 'Outside');
    await provider.writeFile('/battle-of-britain.html', '<h1>Battle of Britain</h1>');

    const first = await loadEditableShellDocument(provider, '/battle-of-britain.html');
    expect(first?.sourcePath).to.equal('/battle-of-britain_files/battle-of-britain.md');
    expect(first?.content).to.contain('squisq-output: ../battle-of-britain.html');
    expect(first?.content).to.contain('# Battle of Britain');
    expect(first?.outsideInEditingEnabled).to.equal(false);

    await provider.writeFile(
      '/battle-of-britain_files/battle-of-britain.md',
      first!.content.replace('# Battle of Britain', '# Edited source'),
    );
    const reopened = await loadEditableShellDocument(provider, '/battle-of-britain.html');
    expect(reopened?.content).to.contain('# Edited source');
  });

  it('rejects regeneration until the exact Markdown opt-in is present', async () => {
    const provider = new MemoryFileSystemProvider('outside-guard', 'Outside guard');
    await provider.writeFile('/guarded.html', '<h1>Original</h1>');
    const opened = await loadEditableShellDocument(provider, '/guarded.html');
    const target = createOutsideInDocumentTarget(provider, opened!.outsideIn!);
    const stringOptIn = opened!.content.replace(
      'squisq-output-format: html',
      'squisq-output-format: html\nsquisq-updatefrommarkdown: "true"',
    );

    let caught: unknown;
    try {
      await target.commit(request(target.key, stringOptIn, opened!.content));
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.contain('squisq-updatefrommarkdown: true');
    expect(await provider.readFile('/guarded.html')).to.equal('<h1>Original</h1>');
  });

  it('commits Markdown, rendered HTML, and the shared hierarchy runtime', async () => {
    const provider = new MemoryFileSystemProvider('outside', 'Outside');
    await provider.writeFile('/history/battle.html', '<h1>Original</h1>');
    const opened = await loadEditableShellDocument(provider, '/history/battle.html');
    const editable = await enableOutsideInMarkdownEditing(provider, opened!);
    const target = createOutsideInDocumentTarget(provider, editable.outsideIn);
    const next = editable.content.replace('# Original', '# Saved together');

    await target.commit(request(target.key, next, editable.content));

    expect(await provider.readFile(editable.sourcePath)).to.equal(next);
    expect(await provider.readFile('/history/battle_files/.original/original.html')).to.equal(
      '<h1>Original</h1>',
    );
    expect(await provider.readFile('/history/battle.html')).to.contain('Saved together');
    expect(await provider.readFile('/_squisq/squisq-player.js')).to.contain('SquisqPlayer');

    const reopened = await loadEditableShellDocument(provider, '/history/battle.html');
    expect(reopened?.outsideInEditingEnabled).to.equal(true);
    const reenabled = await enableOutsideInMarkdownEditing(provider, reopened!);
    const secondTarget = createOutsideInDocumentTarget(provider, reenabled.outsideIn);
    const second = reenabled.content.replace('# Saved together', '# Saved again');
    await secondTarget.commit(request(secondTarget.key, second, reenabled.content));
    expect(await provider.readFile('/history/battle.html')).to.contain('Saved again');
    expect(await provider.readFile('/history/battle_files/.original/original.html')).to.equal(
      '<h1>Original</h1>',
    );
  });
});
