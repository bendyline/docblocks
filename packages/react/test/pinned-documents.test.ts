import { expect } from 'chai';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryFileSystemProvider } from '@bendyline/docblocks/filesystem';
import { FileExplorer } from '../src/FileExplorer/FileExplorer.js';
import {
  loadPinnedDocuments,
  missingPinnedDocumentMessage,
  parsePinnedDocuments,
  pinnedDocumentKey,
  relocatePinnedDocuments,
  removePinnedDocument,
  savePinnedDocuments,
  togglePinnedDocument,
  type PinnedDocument,
  type PinnedDocumentStorage,
} from '../src/DocBlocksShell/pinned-documents.js';
import { act } from './helpers/renderHook.js';

class MemoryStorage implements PinnedDocumentStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const DRAFT: PinnedDocument = {
  workspaceId: 'work',
  workspaceName: 'Work',
  path: 'notes/draft.md',
};

describe('pinned document persistence', () => {
  it('validates, canonicalizes, de-duplicates, and round-trips stored pins', () => {
    const parsed = parsePinnedDocuments([
      { ...DRAFT, path: '/notes//draft.md' },
      DRAFT,
      { ...DRAFT, path: '../outside.md' },
      { ...DRAFT, unexpected: true },
      null,
    ]);

    expect(parsed).to.deep.equal([DRAFT]);

    const storage = new MemoryStorage();
    savePinnedDocuments(parsed, storage);
    expect(loadPinnedDocuments(storage)).to.deep.equal([DRAFT]);
  });

  it('adds newest pins first, toggles them off, and follows file or folder moves', () => {
    const report: PinnedDocument = {
      workspaceId: 'work',
      workspaceName: 'Work',
      path: 'report.md',
    };
    const pinned = togglePinnedDocument([DRAFT], report);
    expect(pinned.map(pinnedDocumentKey)).to.deep.equal([
      pinnedDocumentKey(report),
      pinnedDocumentKey(DRAFT),
    ]);

    expect(togglePinnedDocument(pinned, report)).to.deep.equal([DRAFT]);
    expect(relocatePinnedDocuments([DRAFT], 'work', 'notes', 'archive')).to.deep.equal([
      { ...DRAFT, path: 'archive/draft.md' },
    ]);
    expect(removePinnedDocument([DRAFT], DRAFT)).to.deep.equal([]);
    expect(missingPinnedDocumentMessage(DRAFT)).to.equal(
      'draft.md is no longer at Work/notes/draft.md. Unpin this file?',
    );
  });
});

describe('FileExplorer pinned documents', () => {
  it('renders pins before the active workspace tree, annotates missing files, and opens them', async () => {
    const provider = new MemoryFileSystemProvider('work', 'Work');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let selected: PinnedDocument | null = null;

    try {
      await act(async () => {
        root.render(
          createElement(FileExplorer, {
            provider,
            activeWorkspaceId: 'other',
            pinnedDocuments: [{ ...DRAFT, availability: 'missing' }],
            onPinnedDocumentSelect: (document) => {
              selected = document;
            },
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      const pinnedSection = container.querySelector('.db-pinned-documents');
      const filesToolbar = container.querySelector('.db-explorer-toolbar');
      expect(pinnedSection).not.to.equal(null);
      expect(filesToolbar).not.to.equal(null);
      expect(
        Boolean(
          pinnedSection!.compareDocumentPosition(filesToolbar!) & Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      ).to.equal(true);
      expect(pinnedSection!.textContent).to.include('draft');
      expect(pinnedSection!.textContent).to.include('(missing)');
      expect(pinnedSection!.textContent).not.to.include('Work/notes/draft.md');
      expect(container.querySelector<HTMLButtonElement>('.db-pinned-document')!.title).to.equal(
        'Work/notes/draft.md',
      );

      await act(async () => {
        container.querySelector<HTMLButtonElement>('.db-pinned-document')!.click();
      });
      expect(selected).to.deep.include(DRAFT);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      await provider.v2.dispose();
    }
  });

  it('offers rename, unpin, and delete from both the ellipsis and row context menu', async () => {
    const provider = new MemoryFileSystemProvider('work', 'Work');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const actions: string[] = [];

    try {
      await act(async () => {
        root.render(
          createElement(FileExplorer, {
            provider,
            pinnedDocuments: [{ ...DRAFT, availability: 'available' }],
            onPinnedDocumentSelect: () => undefined,
            onPinnedDocumentRename: () => {
              actions.push('rename');
            },
            onPinnedDocumentUnpin: () => {
              actions.push('unpin');
            },
            onPinnedDocumentDelete: () => {
              actions.push('delete');
            },
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      const more = container.querySelector<HTMLButtonElement>(
        '[aria-label="More actions for draft.md"]',
      )!;
      await act(async () => more.click());
      let menu = document.body.querySelector<HTMLElement>('[role="menu"]')!;
      expect(menu.getAttribute('aria-label')).to.equal('Actions for draft.md');
      expect(menu.textContent).to.include('Rename');
      expect(menu.textContent).to.include('Unpin');
      expect(menu.textContent).to.include('Delete');
      await act(async () => {
        [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
          .find((item) => item.textContent === 'Unpin')!
          .click();
      });

      const pinned = container.querySelector<HTMLButtonElement>('.db-pinned-document')!;
      await act(async () => {
        pinned.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 40 }),
        );
      });
      menu = document.body.querySelector<HTMLElement>('[role="menu"]')!;
      await act(async () => {
        [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
          .find((item) => item.textContent === 'Rename')!
          .click();
      });

      pinned.focus();
      await act(async () => {
        pinned.dispatchEvent(
          new KeyboardEvent('keydown', { bubbles: true, key: 'F10', shiftKey: true }),
        );
        await Promise.resolve();
      });
      menu = document.body.querySelector<HTMLElement>('[role="menu"]')!;
      expect(document.activeElement?.textContent).to.equal('Rename');
      await act(async () => {
        [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
          .find((item) => item.textContent === 'Delete')!
          .click();
      });

      expect(actions).to.deep.equal(['unpin', 'rename', 'delete']);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      await provider.v2.dispose();
    }
  });
});
