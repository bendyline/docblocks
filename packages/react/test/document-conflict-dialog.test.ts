import { expect } from 'chai';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
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
    const button = [...container.querySelectorAll('button')].find(
      (item) => item.textContent === text,
    );
    expect(button, text).not.to.equal(undefined);
    await act(async () => button!.click());
  }

  it('shows both exact read-only versions and distinguishes capture time from file modification', async () => {
    await render();
    const previews = [...container.querySelectorAll('textarea')];
    expect(previews.map((preview) => preview.value)).to.deep.equal([
      props.conflict.localContent,
      props.conflict.externalContent,
    ]);
    expect(previews.every((preview) => preview.readOnly)).to.equal(true);
    expect(container.textContent).to.include('Recovery copy captured:');
    expect(container.textContent).to.include('File last modified:');
    expect(localChoices + savedChoices).to.equal(0);
    await click('Decide later');
    expect(localChoices + savedChoices).to.equal(0);
    expect(closes).to.equal(1);
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
    expect(container.textContent).to.include('File modification time unavailable');
    expect(container.textContent).not.to.include('File last modified:');
  });

  it('still offers both branches when file metadata cannot be read', async () => {
    props.readSavedFile = async () => {
      throw new Error('permission denied');
    };
    await render();
    expect(container.querySelectorAll('textarea')).to.have.length(2);
    expect(container.textContent).to.include('File modification time unavailable');
  });

  it('explains a deletion and keeps the dialog open if resolution fails', async () => {
    props.conflict = { ...props.conflict, externalContent: null };
    props.onUseSaved = async () => false;
    await render();
    expect(container.textContent).to.include('The saved file no longer exists.');
    await click('Accept deletion');
    expect(closes).to.equal(0);
    expect(container.querySelector('[role="alert"]')?.textContent).to.include('Could not resolve');
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
      ...container.querySelectorAll<HTMLButtonElement>('.db-conflict-version button'),
    ];
    expect(choices.every((button) => button.disabled)).to.equal(true);
    await click('Use saved file');
    expect(savedChoices).to.equal(0);
    await act(async () => finish(false));
    expect(choices.every((button) => !button.disabled)).to.equal(true);
    expect(closes).to.equal(0);
  });
});
