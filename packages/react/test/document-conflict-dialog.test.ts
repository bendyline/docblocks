import { expect } from 'chai';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { resolveTheme } from '@bendyline/squisq/schemas';
import DocumentConflictDialog, {
  type DocumentConflictDialogProps,
} from '../src/DocBlocksShell/DocumentConflictDialog.js';

describe('Document conflict comparison', () => {
  let container: HTMLDivElement;
  let root: Root;
  let localChoices: number;
  let savedChoices: number;
  let closes: number;
  let props: DocumentConflictDialogProps;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    localChoices = savedChoices = closes = 0;
    props = {
      conflict: {
        targetKey: 'workspace:notes.md',
        recoveredDraft: true,
        recoveredDraftCapturedAt: Date.parse('2026-10-04T10:00:00Z'),
        localContent: '# Old draft\n\nUnfinished thoughts',
        localRevision: 4,
        externalContent: '# Saved document\n\nLatest edits',
        externalVersion: 'v2',
      },
      fileName: 'notes.md',
      theme: 'light',
      readSavedFile: async () => ({
        content: '# Saved document\n\nLatest edits',
        lastModified: '2026-10-05T10:00:00Z',
      }),
      onUseLocal: async () => {
        localChoices++;
        return true;
      },
      onUseSaved: async () => {
        savedChoices++;
        return true;
      },
      onClose: () => closes++,
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render() {
    await act(async () => root.render(createElement(DocumentConflictDialog, props)));
  }

  async function click(text: string) {
    const button = [...document.body.querySelectorAll('button')].find(
      (item) => item.textContent === text,
    );
    expect(button, text).not.to.equal(undefined);
    await act(async () => button!.click());
  }

  function preview(label: string): HTMLElement | null {
    return document.body.querySelector<HTMLElement>(`[aria-label="${label} preview"]`);
  }

  /** A color as this DOM serializes it, so theme colors compare exactly. */
  function cssColor(color: string): string {
    const probe = document.createElement('div');
    probe.style.background = color;
    return probe.style.background;
  }

  it('renders both versions as pages beside a source diff and distinguishes capture time from file modification', async () => {
    await render();
    expect(document.body.querySelectorAll('textarea')).to.have.length(0);
    expect(preview('Recovery draft')?.textContent).to.include('Unfinished thoughts');
    expect(preview('Saved file')?.textContent).to.include('Latest edits');
    expect(document.body.querySelector('section[aria-label="Differences"]')).not.to.equal(null);
    expect(document.body.textContent).to.include('Recovery copy captured:');
    expect(document.body.textContent).to.include('File last modified:');
    expect(localChoices + savedChoices).to.equal(0);
    await click('Decide later');
    expect(localChoices + savedChoices).to.equal(0);
    expect(closes).to.equal(1);
  });

  it('draws each version in its own theme, and the workspace default only when it names none', async () => {
    props.defaultThemeId = 'minimalist';
    props.conflict = {
      ...props.conflict,
      externalContent: '---\ntheme: bold\n---\n\n# Saved document\n\nLatest edits',
    };
    await render();
    expect(preview('Recovery draft')?.style.background).to.equal(
      cssColor(resolveTheme('minimalist').colors.background),
    );
    expect(preview('Saved file')?.style.background).to.equal(
      cssColor(resolveTheme('bold').colors.background),
    );
  });

  it('offers inline, side-by-side and changes-only diff views, widening the diff for side by side', async () => {
    await render();
    const view = document.body.querySelector<HTMLSelectElement>('.db-conflict-diff select')!;
    expect([...view.options].map((option) => option.textContent)).to.deep.equal([
      'Inline',
      'Side by side',
      'Changes only',
    ]);
    expect(view.value).to.equal('inline');
    const columns = document.body.querySelector('.db-conflict-columns')!;
    expect(columns.classList.contains('db-conflict-columns--wide-diff')).to.equal(false);
    await act(async () => {
      view.value = 'side-by-side';
      view.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(columns.classList.contains('db-conflict-columns--wide-diff')).to.equal(true);
  });

  it('shows the exact text of a file that is not Markdown', async () => {
    props.fileName = 'settings.json';
    props.conflict = {
      ...props.conflict,
      localContent: '{ "draft": true }',
      externalContent: '{ "draft": false }',
    };
    await render();
    const previews = [...document.body.querySelectorAll('textarea')];
    expect(previews.map((item) => item.value)).to.deep.equal([
      props.conflict.localContent,
      props.conflict.externalContent,
    ]);
    expect(previews.every((item) => item.readOnly)).to.equal(true);
  });

  for (const choice of ['Replace file with draft', 'Use saved file']) {
    it(`resolves only the explicitly selected branch: ${choice}`, async () => {
      await render();
      await click(choice);
      expect(localChoices).to.equal(choice === 'Replace file with draft' ? 1 : 0);
      expect(savedChoices).to.equal(choice === 'Use saved file' ? 1 : 0);
      expect(closes).to.equal(1);
    });
  }

  it('never attaches a different file version timestamp to the preview', async () => {
    props.readSavedFile = async () => ({
      content: 'changed again',
      lastModified: '2026-10-05T12:00:00Z',
    });
    await render();
    expect(document.body.textContent).to.include('File modification time unavailable');
    expect(document.body.textContent).not.to.include('File last modified:');
  });

  it('still offers both branches when file metadata cannot be read', async () => {
    props.readSavedFile = async () => {
      throw new Error('permission denied');
    };
    await render();
    expect(document.body.querySelectorAll('.db-conflict-preview')).to.have.length(2);
    expect(document.body.textContent).to.include('File modification time unavailable');
  });

  it('explains a deletion and keeps the dialog open if resolution fails', async () => {
    props.conflict = { ...props.conflict, externalContent: null };
    props.onUseSaved = async () => false;
    await render();
    expect(document.body.textContent).to.include('The saved file no longer exists.');
    await click('Accept deletion');
    expect(closes).to.equal(0);
    expect(document.body.querySelector('[role="alert"]')?.textContent).to.include(
      'Could not resolve',
    );
  });

  it('disables both choices while a save is in flight', async () => {
    let finish!: (value: boolean) => void;
    props.onUseLocal = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    await render();
    await click('Replace file with draft');
    const choices = [
      ...document.body.querySelectorAll<HTMLButtonElement>('.db-conflict-version button'),
    ];
    expect(choices.every((button) => button.disabled)).to.equal(true);
    await click('Use saved file');
    expect(savedChoices).to.equal(0);
    await act(async () => finish(false));
    expect(choices.every((button) => !button.disabled)).to.equal(true);
    expect(closes).to.equal(0);
  });
});
