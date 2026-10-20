import { expect } from 'chai';
import { MemoryFileSystemProvider, parseWorkspacePath } from '@bendyline/docblocks/filesystem';
import { DocumentSession } from '@bendyline/docblocks/document';
import {
  ensureShellWikiArticle,
  wikiArticleExtension,
} from '../src/DocBlocksShell/wiki-articles.js';
import {
  createOutsideInDocumentTarget,
  loadEditableShellDocument,
} from '../src/DocBlocksShell/outside-in.js';

describe('HTML wiki articles', function () {
  this.timeout(30_000);
  for (const format of ['web-static', 'web-interactive'] as const) {
    it(`creates and regenerates ${format} articles through their Markdown companions`, async () => {
      const provider = new MemoryFileSystemProvider(`wiki-${format}`, 'Wiki');
      const path = parseWorkspacePath('notes/reference/blah.html');
      expect(wikiArticleExtension(format)).to.equal('.html');
      expect(await ensureShellWikiArticle(provider, path, format)).to.equal(true);
      const opened = await loadEditableShellDocument(provider, path);
      expect(opened?.sourcePath).to.equal('notes/reference/blah_files/blah.md');
      expect(opened?.outsideInEditingEnabled).to.equal(true);
      expect(opened?.content).to.contain(
        `squisq-html-output: ${format === 'web-static' ? 'static' : 'interactive'}`,
      );
      expect(await provider.readFile(path)).to.contain('<html');
      const session = new DocumentSession({ autoSaveEnabled: false });
      await session.transitionTo(
        createOutsideInDocumentTarget(provider, opened!.outsideIn!),
        opened!.content,
      );
      const state = session.getSnapshot();
      session.edit(
        `${opened!.content}\nWiki content survives. [[missing|Not yet]] [[existing|Existing article]]\n`,
        {
          targetKey: state.targetKey!,
          generation: state.generation,
        },
      );
      await provider.writeFile('notes/reference/existing.html', '<p>Existing</p>');
      await session.flush();
      const html = await provider.readFile(path);
      expect(html).to.contain('Wiki content survives.');
      expect(html).to.contain('Existing article');
      expect(html).to.contain('Not yet');
      if (format === 'web-static') {
        expect(html).to.contain('href="existing.html"');
        expect(html).not.to.contain('href="missing.html"');
      } else {
        expect(html).to.contain('existing.html');
        expect(html).not.to.contain('"url":"missing.html"');
      }
      const source = await provider.readFile(opened!.sourcePath);
      expect(source).to.contain('[[existing|Existing article]]');
      expect(await ensureShellWikiArticle(provider, path, format)).to.equal(false);
      expect(await provider.readFile(path)).to.equal(html);
      expect(await provider.readFile(opened!.sourcePath)).to.equal(source);
      expect(await provider.exists('notes/reference/blah.md')).to.equal(false);
      await session.cancel();
      await provider.v2.dispose();
    });
  }
});
