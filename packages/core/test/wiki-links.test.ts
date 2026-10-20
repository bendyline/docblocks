import { expect } from 'chai';
import { MemoryFileSystemProvider } from '../src/filesystem/memory-provider.js';
import {
  resolveWikiArticlePath,
  findWikiArticle,
  ensureWikiArticle,
  wikiArticleExists,
  suggestWikiArticles,
} from '../src/filesystem/wiki-links.js';
import { FsError } from '../src/filesystem/fs-error.js';

describe('workspace wiki articles', () => {
  it('suggests immediate articles and empty folders relative to the source', () => {
    const files = [
      'notes/source.md',
      'notes/foo.md',
      'notes/reference/Alpha.md',
      'elsewhere.md',
      'notes/picture.png',
    ].map((path) => ({ path }));
    const directories = ['', 'notes', 'notes/empty', 'notes/reference', 'outside'];
    expect(suggestWikiArticles(files, directories, 'notes/source.md', '')).to.deep.equal([
      { target: 'empty/', label: 'empty/', kind: 'folder' },
      { target: 'reference/', label: 'reference/', kind: 'folder' },
      { target: 'foo', label: 'foo', kind: 'article' },
    ]);
    expect(
      suggestWikiArticles(files, directories, 'notes/source.md', 'reference/al'),
    ).to.deep.equal([{ target: 'reference/Alpha', label: 'Alpha', kind: 'article' }]);
    for (const query of ['../', '/outside', 'a%2fb', 'foo|label']) {
      expect(suggestWikiArticles(files, directories, 'notes/source.md', query)).to.deep.equal([]);
    }
  });
  it('disambiguates formats using the workspace preference and bounds suggestions', () => {
    const files = ['foo.md', 'foo.html', 'bar.html'].map((path) => ({ path }));
    expect(suggestWikiArticles(files, [], 'source.md', 'foo', '.html')).to.deep.equal([
      { target: 'foo', label: 'foo', kind: 'article' },
      { target: 'foo.md', label: 'foo.md', kind: 'article' },
    ]);
    expect(
      suggestWikiArticles(files, [], 'source.md', 'foo', '.md', true).map((x) => x.target),
    ).to.have.members(['foo.md', 'foo.html']);
    expect(
      suggestWikiArticles(
        Array.from({ length: 30 }, (_, i) => ({ path: `a${i}.md` })),
        [],
        'source.md',
        '',
      ),
    ).to.have.length(20);
  });
  it('prefers HTML defaults, reuses existing Markdown, and respects explicit extensions', async () => {
    const provider = new MemoryFileSystemProvider('wiki-html', 'HTML');
    expect(
      await findWikiArticle(provider, 'notes/index.html', 'reference/new', '.html'),
    ).to.deep.equal({
      path: 'notes/reference/new.html',
      relativePath: 'reference/new.html',
      exists: false,
    });
    await provider.writeFile('notes/foo.md', 'Existing Markdown');
    expect((await findWikiArticle(provider, 'notes/index.html', 'foo', '.html')).path).to.equal(
      'notes/foo.md',
    );
    await provider.writeFile('notes/foo.html', '<p>Existing HTML</p>');
    expect((await findWikiArticle(provider, 'notes/index.html', 'foo', '.html')).path).to.equal(
      'notes/foo.html',
    );
    expect((await findWikiArticle(provider, 'notes/index.html', 'foo.md', '.html')).path).to.equal(
      'notes/foo.md',
    );
    expect(resolveWikiArticlePath('notes/index.html', 'reference/foo.html')).to.equal(
      'notes/reference/foo.html',
    );
  });
  it('resolves beside the source and exclusively creates missing subfolder articles', async () => {
    const provider = new MemoryFileSystemProvider('wiki', 'Wiki');
    const path = resolveWikiArticlePath('notes/source.md', 'reference/blah');
    expect(path).to.equal('notes/reference/blah.md');
    expect(await wikiArticleExists(provider, path)).to.equal(false);
    expect(await ensureWikiArticle(provider, path)).to.equal(true);
    expect(await provider.readFile(path)).to.equal('');
    await provider.writeFile(path, 'Authored content');
    expect(await ensureWikiArticle(provider, path)).to.equal(false);
    expect(await provider.readFile(path)).to.equal('Authored content');
  });
  it('does not overwrite a concurrent creator', async () => {
    const provider = new MemoryFileSystemProvider('wiki-race', 'Wiki');
    const path = resolveWikiArticlePath('source.md', 'foo');
    const results = await Promise.all([
      ensureWikiArticle(provider, path),
      ensureWikiArticle(provider, path),
    ]);
    expect(results.sort()).to.deep.equal([false, true]);
  });
  it('rejects traversal, absolute paths, URLs and encoded separators', () => {
    for (const target of [
      '../foo',
      '/foo',
      '//server/foo',
      'C:/foo',
      'a/../../foo',
      '%2e%2e/foo',
      'a%2fb',
      'a\\b',
    ]) {
      expect(() => resolveWikiArticlePath('notes/source.md', target), target).to.throw(FsError);
    }
  });
  it('does not mistake folders or failed metadata reads for missing articles', async () => {
    const provider = new MemoryFileSystemProvider('wiki-errors', 'Wiki');
    const path = resolveWikiArticlePath('source.md', 'folder');
    await provider.createDirectory(path);
    try {
      await ensureWikiArticle(provider, path);
      expect.fail('accepted a folder');
    } catch (error) {
      expect(error).to.be.instanceOf(FsError).with.property('code', 'type-mismatch');
    }
    await provider.v2.dispose();
    try {
      await wikiArticleExists(provider, path);
      expect.fail('accepted a disposed provider');
    } catch (error) {
      expect(error).to.be.instanceOf(FsError).with.property('code', 'disposed');
    }
  });
});
