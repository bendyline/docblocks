/**
 * Workspace settings meet outside-in documents:
 *   • the workspace default theme styles regenerated pages only when the
 *     document names no theme of its own (exporters let an explicit theme
 *     beat frontmatter, so the shell must not pass one when the doc has one)
 *   • a generated catalog page opens read-only and is never imported (no
 *     companion folder appears), and the editor can never overwrite it
 */
import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryFileSystemProvider } from '@bendyline/docblocks/filesystem';
import { setFrontmatterValues } from '@bendyline/squisq/markdown';
import {
  createNewOutsideInDocument,
  createOutsideInDocumentTarget,
  loadEditableShellDocument,
} from '../src/DocBlocksShell/outside-in.js';
import { assertNotGeneratedCatalog } from '../src/WorkspaceSettings/managed-outputs.js';
import {
  GeneratedCatalogPage,
  GeneratedFileFrame,
} from '../src/WorkspaceSettings/GeneratedFileView.js';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const warmEarth = { defaultThemeId: () => 'warm-earth' };

async function renderStatic(
  id: string,
  frontmatterTheme: string | null,
  render?: typeof warmEarth,
): Promise<string> {
  const provider = new MemoryFileSystemProvider(id, 'Theme');
  const created = await createNewOutsideInDocument(provider, 'page.html', 'static');
  const content = frontmatterTheme
    ? setFrontmatterValues(created.content, { 'squisq-theme': frontmatterTheme })
    : created.content;
  const target = createOutsideInDocumentTarget(provider, created.outsideIn, undefined, render);
  await target.commit({
    targetKey: target.key,
    content,
    revision: 2,
    persistedRevision: 1,
    persistedContent: created.content,
    reason: 'manual',
  });
  const html = (await provider.readFile('page.html'))!;
  await provider.v2.dispose();
  return html;
}

describe('workspace default theme for outside-in pages', function () {
  this.timeout(30_000);

  it('styles a page without its own theme with the workspace default', async () => {
    const plain = await renderStatic('theme-plain', null);
    const workspaceThemed = await renderStatic('theme-default', null, warmEarth);
    const explicitlyThemed = await renderStatic('theme-explicit', 'warm-earth');
    expect(workspaceThemed).not.to.equal(plain);
    // Same styling as if the document had named the theme itself (titles aside).
    expect(workspaceThemed.match(/<style>[\s\S]*?<\/style>/)?.[0]).to.equal(
      explicitlyThemed.match(/<style>[\s\S]*?<\/style>/)?.[0],
    );
  });

  it('never overrides a theme the document chose', async () => {
    const own = await renderStatic('theme-own', 'gezellig');
    const ownWithDefault = await renderStatic('theme-own-default', 'gezellig', warmEarth);
    expect(ownWithDefault).to.equal(own);
  });
});

describe('generated catalog files', () => {
  const catalogPage =
    '<!DOCTYPE html>\n<!-- docblocks-workspace-catalog v1 inputs=sha256:' +
    'a'.repeat(64) +
    ' -->\n<html><body><h1>Articles</h1><ul><li><a href="a.html">A</a></li></ul></body></html>\n';

  it('opens the catalog page as its own HTML, read-only, without importing it', async () => {
    const provider = new MemoryFileSystemProvider('catalog-open', 'Catalog');
    await provider.writeFile('index.html', catalogPage);
    const opened = await loadEditableShellDocument(provider, 'index.html');
    expect(opened?.managedOutput).to.equal('catalog-html');
    expect(opened?.outsideIn).to.equal(null);
    expect(opened?.outsideInEditingEnabled).to.equal(false);
    // The page itself, not a Markdown conversion of it.
    expect(opened?.content).to.equal(catalogPage);
    expect(await provider.exists('index_files')).to.equal(false);
  });

  it('opens catalog data read-only and leaves ordinary JSON editable', async () => {
    const provider = new MemoryFileSystemProvider('catalog-json', 'Catalog');
    await provider.writeFile(
      'catalog.json',
      '{\n  "generator": "docblocks-workspace-catalog",\n  "version": 1\n}\n',
    );
    await provider.writeFile('data.json', '{"a":1}');
    expect((await loadEditableShellDocument(provider, 'catalog.json'))?.managedOutput).to.equal(
      'catalog-json',
    );
    const data = await loadEditableShellDocument(provider, 'data.json');
    expect(data?.managedOutput).to.equal(undefined);
    expect(data?.outsideInEditingEnabled).to.equal(true);
  });

  it('refuses to commit over a generated catalog', async () => {
    const provider = new MemoryFileSystemProvider('catalog-guard', 'Catalog');
    await provider.writeFile('index.html', catalogPage);
    await provider.writeFile('mine.html', '<p>mine</p>');
    let error: unknown;
    try {
      await assertNotGeneratedCatalog(provider, 'index.html');
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(Error);
    await assertNotGeneratedCatalog(provider, 'mine.html');
    await assertNotGeneratedCatalog(provider, 'notes.md');
  });
});

describe('generated catalog views', () => {
  async function render(element: React.ReactElement) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(element));
    return {
      container,
      async unmount() {
        await act(async () => root.unmount());
        container.remove();
      },
    };
  }

  it('shows the page itself in a fully sandboxed frame, labelled as generated', async () => {
    let opened = 0;
    const view = await render(
      createElement(GeneratedCatalogPage, {
        html: '<!DOCTYPE html>\n<h1>Articles</h1><script>alert(1)</script>',
        fileName: 'index.html',
        onOpenSettings: () => {
          opened += 1;
        },
      }),
    );
    const frame = view.container.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).to.equal('');
    expect(frame.getAttribute('srcdoc')).to.contain('<h1>Articles</h1>');
    expect(view.container.textContent).to.contain('Generated by DocBlocks · read-only.');
    view.container.querySelector<HTMLButtonElement>('button')!.click();
    expect(opened).to.equal(1);
    await view.unmount();
  });

  it('adds the notice only around generated files', async () => {
    const plain = await render(
      createElement(GeneratedFileFrame, { kind: undefined }, createElement('p', null, 'doc')),
    );
    expect(plain.container.innerHTML).to.equal('<p>doc</p>');
    await plain.unmount();
    const data = await render(
      createElement(GeneratedFileFrame, { kind: 'catalog-json' }, createElement('p', null, 'json')),
    );
    expect(data.container.textContent).to.contain('catalog data is rebuilt');
    expect(data.container.querySelector('.db-generated-file-body')?.textContent).to.equal('json');
    await data.unmount();
  });
});
