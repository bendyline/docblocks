import { expect } from 'chai';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { resolveTheme } from '@bendyline/squisq/schemas';
import DocumentConflictDialog, {
  type DocumentConflictDialogProps,
} from '../src/DocBlocksShell/DocumentConflictDialog.js';
import { startsOnPhoneLayout } from '../src/DocBlocksShell/compare-layout.js';

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

  it('lets the user combine both versions by hand and saves what they end up with', async () => {
    const merged: string[] = [];
    props.conflict = { ...props.conflict, recoveredDraft: false };
    props.onUseMerged = async (content) => {
      merged.push(content);
      return true;
    };
    await render();
    await click('Combine by hand');
    expect(document.body.querySelector('section[aria-label="Combined version"]')).not.to.equal(
      null,
    );
    // The two whole-version choices step aside while combining.
    expect(document.body.querySelector<HTMLElement>('.db-conflict-columns')?.hidden).to.equal(true);
    await click('Back to comparing');
    expect(document.body.querySelector('section[aria-label="Combined version"]')).to.equal(null);

    await click('Combine by hand');
    await click('Save combined version');
    // Untouched, the combined version is the user's own text.
    expect(merged).to.deep.equal(['# Old draft\n\nUnfinished thoughts']);
    expect(localChoices + savedChoices).to.equal(0);
    expect(closes).to.equal(1);
  });

  it('offers no combining when the file was deleted or the host cannot save a combination', async () => {
    await render();
    const combine = () =>
      [...document.body.querySelectorAll('button')].some(
        (item) => item.textContent === 'Combine by hand',
      );
    expect(combine()).to.equal(false);
    props.onUseMerged = async () => true;
    props.conflict = { ...props.conflict, externalContent: null };
    await render();
    expect(combine()).to.equal(false);
  });

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

  for (const choice of ['Use draft', 'Use saved file']) {
    it(`resolves only the explicitly selected branch: ${choice}`, async () => {
      await render();
      await click(choice);
      expect(localChoices).to.equal(choice === 'Use draft' ? 1 : 0);
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
    await click('Use draft');
    const choices = [
      ...document.body.querySelectorAll<HTMLButtonElement>('.db-compare-actions button'),
    ];
    expect(choices.map((button) => button.textContent)).to.deep.equal([
      'Use draft',
      'Use saved file',
      'Decide later',
    ]);
    expect(choices.every((button) => button.disabled)).to.equal(true);
    await click('Use saved file');
    expect(savedChoices).to.equal(0);
    await act(async () => finish(false));
    expect(choices.every((button) => !button.disabled)).to.equal(true);
    expect(closes).to.equal(0);
  });

  it('puts the choices before the versions they choose between', async () => {
    props.onUseMerged = async () => true;
    await render();
    const body = document.body.querySelector('.db-dialog-body')!;
    const actions = body.querySelector('.db-compare-actions')!;
    const columns = body.querySelector('.db-conflict-columns')!;
    // Nothing to choose with sits inside or after the versions.
    expect(
      actions.compareDocumentPosition(columns) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).to.not.equal(0);
    expect(columns.querySelectorAll('button')).to.have.length(0);
    expect(
      [...actions.querySelectorAll('button')].map((button) => button.textContent),
    ).to.deep.equal(['Use draft', 'Use saved file', 'Combine by hand', 'Decide later']);
    // While combining, the bar holds the choices for that.
    await click('Combine by hand');
    expect(
      [...actions.querySelectorAll('button')].map((button) => button.textContent),
    ).to.deep.equal(['Save combined version', 'Back to comparing', 'Decide later']);
  });

  it('names each version in a tab, starting on the differences, and switches with the arrow keys', async () => {
    await render();
    const tabs = [...document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).to.deep.equal(['Draft', 'Changes', 'Saved file']);
    const selected = () =>
      tabs
        .filter((tab) => tab.getAttribute('aria-selected') === 'true')
        .map((tab) => tab.textContent);
    const shown = () =>
      document.body.querySelector('.db-compare-pane--active')?.getAttribute('aria-label');
    expect(selected()).to.deep.equal(['Changes']);
    expect(shown()).to.equal('Differences');
    // Each tab controls the region it shows.
    for (const tab of tabs) {
      expect(document.getElementById(tab.getAttribute('aria-controls')!)?.tagName).to.equal(
        'SECTION',
      );
    }
    await act(async () => tabs[2]!.click());
    expect(shown()).to.equal('Saved file');
    await act(async () => {
      tabs[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(selected()).to.deep.equal(['Draft']);
    expect(shown()).to.equal('Recovery draft');
    expect(tabs[0]!.tabIndex).to.equal(0);
    expect(tabs[2]!.tabIndex).to.equal(-1);
  });

  it('shows only the changes, at first, on a phone', async () => {
    expect(startsOnPhoneLayout()).to.equal(false);
    document.documentElement.dataset.dbWidth = 'compact';
    try {
      expect(startsOnPhoneLayout()).to.equal(true);
      await render();
      expect(
        document.body.querySelector<HTMLSelectElement>('.db-conflict-diff select')!.value,
      ).to.equal('changes');
    } finally {
      delete document.documentElement.dataset.dbWidth;
    }
  });

  it('marks each version, its tab and the choice that keeps it with the same side of the diff', async () => {
    await render();
    const side = (selector: string) =>
      [...document.body.querySelectorAll<HTMLElement>(selector)].map((element) => [
        element.getAttribute('aria-label') ?? element.textContent,
        element.dataset.side ?? null,
      ]);
    // The diff runs from the draft to the saved file: the draft's lines show
    // as taken out (red), the saved file's as added (green).
    expect(side('.db-compare-actions button')).to.deep.equal([
      ['Use draft', 'removed'],
      ['Use saved file', 'inserted'],
      ['Decide later', null],
    ]);
    expect(side('[role="tab"]')).to.deep.equal([
      ['Draft', 'removed'],
      ['Changes', null],
      ['Saved file', 'inserted'],
    ]);
    expect(side('.db-conflict-columns > section')).to.deep.equal([
      ['Recovery draft', 'removed'],
      ['Differences', null],
      ['Saved file', 'inserted'],
    ]);
    // Nothing above the choices but the title: the versions say the rest.
    expect(document.body.querySelector('.db-compare-intro')).to.equal(null);
  });
});
