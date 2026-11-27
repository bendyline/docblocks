import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryFileSystemProvider, parseWorkspacePath } from '@bendyline/docblocks/filesystem';
import { defaultFolderSettings, type KindFolder } from '@bendyline/docblocks/folders';
import { fileTypeGlyph, treeEntryGlyph } from '../src/FileExplorer/entry-glyph.js';
import { FileExplorer } from '../src/FileExplorer/FileExplorer.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

describe('file tree glyphs', () => {
  it('reads a file type from its extension, in any case', () => {
    expect(fileTypeGlyph('Report.md')).to.equal('document');
    expect(fileTypeGlyph('Q3 plan.DOCX')).to.equal('document');
    expect(fileTypeGlyph('scan.pdf')).to.equal('document');
    expect(fileTypeGlyph('budget.xlsx')).to.equal('spreadsheet');
    expect(fileTypeGlyph('export.csv')).to.equal('spreadsheet');
    expect(fileTypeGlyph('pitch.pptx')).to.equal('presentation');
    expect(fileTypeGlyph('site.html')).to.equal('web');
    expect(fileTypeGlyph('sketch.png')).to.equal('image');
    expect(fileTypeGlyph('clip.MOV')).to.equal('video');
    expect(fileTypeGlyph('narration.mp3')).to.equal('audio');
    expect(fileTypeGlyph('script.ts')).to.equal('code');
    expect(fileTypeGlyph('config.yaml')).to.equal('data');
    expect(fileTypeGlyph('bundle.dbk')).to.equal('archive');
  });

  it('falls back to a plain file for unknown, missing or dotfile extensions', () => {
    expect(fileTypeGlyph('model.gguf')).to.equal('file');
    expect(fileTypeGlyph('Makefile')).to.equal('file');
    expect(fileTypeGlyph('.env')).to.equal('file');
  });

  it("gives folders a folder, or their kind's glyph", () => {
    const folder = { kind: 'directory', name: 'Projects.md' } as const;
    // A folder's name never decides its glyph, even one that looks like a file's.
    expect(treeEntryGlyph(folder)).to.equal('folder');
    expect(treeEntryGlyph(folder, null)).to.equal('folder');
    expect(treeEntryGlyph(folder, 'journal')).to.equal('journal');
    expect(treeEntryGlyph({ kind: 'file', name: 'Tasks' }, 'tasks')).to.equal('file');
  });
});

describe('FileExplorer kind folder glyphs', () => {
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;
  let provider: MemoryFileSystemProvider;

  beforeEach(async () => {
    provider = new MemoryFileSystemProvider('mem', 'Memory');
    for (const path of ['Tasks', 'Tasks/Done', 'Notes']) {
      await provider.v2.createDirectory(parseWorkspacePath(path), { mode: 'create' });
    }
    await provider.v2.writeFile(parseWorkspacePath('Report.md'), new TextEncoder().encode('# R'), {
      mode: 'create',
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    await provider.v2.dispose();
  });

  async function render(kindFolders?: readonly KindFolder[]): Promise<void> {
    await act(async () => {
      root.render(createElement(FileExplorer, { provider, kindFolders }));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }

  const glyphFor = (path: string) =>
    container
      .querySelector(`[role="treeitem"][data-path="${path}"] .db-tree-glyph`)
      ?.getAttribute('data-glyph');

  it('marks the kind folders it is given and leaves the rest ordinary', async () => {
    await render([{ path: parseWorkspacePath('Tasks'), settings: defaultFolderSettings('tasks') }]);
    expect(glyphFor('Tasks')).to.equal('tasks');
    expect(glyphFor('Notes')).to.equal('folder');
    expect(glyphFor('Report.md')).to.equal('document');

    // A folder inside a kind folder is one of its lists, not a kind folder.
    await act(async () => {
      container.querySelector<HTMLElement>('[role="treeitem"][data-path="Tasks"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(glyphFor('Tasks/Done')).to.equal('folder');
  });

  const rowFor = (path: string) =>
    container.querySelector<HTMLElement>(`[role="treeitem"][data-path="${path}"]`);
  const hasChevron = (path: string) => rowFor(path)?.querySelector('.db-tree-icon svg') != null;
  const click = async (path: string) => {
    await act(async () => {
      rowFor(path)?.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  };

  it('drops the chevron of a folder it opened and found empty', async () => {
    await render();
    expect(hasChevron('Notes'), 'unknown until listed').to.equal(true);
    await click('Notes');
    expect(hasChevron('Notes')).to.equal(false);
    expect(rowFor('Notes')?.hasAttribute('aria-expanded')).to.equal(false);
    // A folder with something in it keeps its chevron once listed.
    await click('Tasks');
    expect(hasChevron('Tasks')).to.equal(true);
    expect(rowFor('Tasks')?.getAttribute('aria-expanded')).to.equal('true');
  });

  it("takes the host's word for an empty folder unless the tree has seen contents", async () => {
    const folderContents = (path: string) => (path === 'Tasks/Done' ? 'some' : 'none') as const;
    await act(async () => {
      root.render(createElement(FileExplorer, { provider, folderContents }));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    // The host says empty and the tree has not looked: no chevron.
    expect(hasChevron('Notes')).to.equal(false);
    // The host is behind: Tasks holds Done. Clicking still lists it, and the tree's look wins.
    expect(hasChevron('Tasks')).to.equal(false);
    await click('Tasks');
    expect(hasChevron('Tasks')).to.equal(true);
    expect(hasChevron('Tasks/Done')).to.equal(true);
  });

  it('shows plain folders until the kind folders are known', async () => {
    await render();
    expect(glyphFor('Tasks')).to.equal('folder');
    await render([{ path: parseWorkspacePath('Tasks'), settings: defaultFolderSettings('tasks') }]);
    expect(glyphFor('Tasks')).to.equal('tasks');
  });
});
