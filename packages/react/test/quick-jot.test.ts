/**
 * Quick Jot: its buttons follow what the workspace offers, a used jot clears
 * and a failed one stays, pastes and drops become attachments, and the
 * actions write through the pages' own operations.
 */
import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { QuickJot } from '../src/QuickJot/QuickJot.js';
import { createQuickJotActions, type QuickJotActions } from '../src/QuickJot/quick-jot-actions.js';
import type { JotDraft, JotOutcome } from '../src/QuickJot/quick-jot-model.js';
import type { DescribedTask, JournalAppendOptions } from '../src/Home/page-actions.js';
import type { AttachmentFile } from '../src/Home/attachments.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

/** Write through the prototype setter so React's value tracker sees a change. */
function typeInto(element: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(element) as object,
    'value',
  )?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function pasteEvent(flavours: Record<string, string>, files: File[] = []): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (type: string) => flavours[type] ?? '', files, types: Object.keys(flavours) },
  });
  return event;
}

function dragEvent(type: string, files: File[], types = ['Files']): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { types, files, dropEffect: 'none' },
  });
  return event;
}

const png = (name = 'venue.png') => new File(['png'], name, { type: 'image/png' });

describe('QuickJot', () => {
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;
  let drafts: { action: string; draft: JotDraft }[];
  let outcome: JotOutcome;

  function actions(offers: { task?: boolean; journal?: boolean } = {}): QuickJotActions {
    const record = (action: string) => async (draft: JotDraft) => {
      drafts.push({ action, draft });
      return outcome;
    };
    return {
      toDocument: record('document'),
      ...(offers.task ? { toTask: record('task') } : {}),
      ...(offers.journal ? { toJournal: record('journal') } : {}),
    };
  }

  async function render(quickJotActions: QuickJotActions): Promise<void> {
    await act(async () => {
      root.render(createElement(QuickJot, { actions: quickJotActions, today: '2026-11-24' }));
    });
  }

  const field = () => {
    const element = container.querySelector<HTMLTextAreaElement>('textarea');
    if (!element) throw new Error('Quick Jot text missing');
    return element;
  };
  const button = (name: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  const status = () => container.querySelector('.db-quick-jot-status')?.textContent ?? '';
  const chips = () =>
    Array.from(
      container.querySelectorAll('.db-quick-jot-attachment-name'),
      (chip) => chip.textContent,
    );

  beforeEach(() => {
    drafts = [];
    outcome = 'used';
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('offers task and journal buttons only when the workspace has them', async () => {
    await render(actions());
    await act(async () => typeInto(field(), 'Groceries'));
    expect(button('New document from jot')).to.not.equal(null);
    expect(button('New task from jot')).to.equal(null);
    expect(button('Add jot to journal')).to.equal(null);
    expect(button('Paste from clipboard')).to.not.equal(null);
    await render(actions({ task: true, journal: true }));
    expect(button('New task from jot')).to.not.equal(null);
    expect(button('Add jot to journal')).to.not.equal(null);
    // Each carries a word for when there is room; its name stays the full one.
    expect(
      ['New document from jot', 'New task from jot', 'Add jot to journal'].map(
        (name) => button(name)!.textContent,
      ),
    ).to.deep.equal(['Doc', 'Task', 'Journal']);
  });

  it('shows the make buttons only once the jot has text or files', async () => {
    await render(actions({ task: true, journal: true }));
    const makeGroup = () =>
      container.querySelector('[role="group"][aria-label="Make the jot into"]');
    expect(makeGroup()).to.equal(null);
    expect(button('Paste from clipboard')).to.not.equal(null);
    // Blank space is not something to make anything from.
    await act(async () => typeInto(field(), '  \n '));
    expect(makeGroup()).to.equal(null);
    await act(async () => typeInto(field(), 'Call Priya'));
    expect(makeGroup()).to.not.equal(null);
    expect(button('New task from jot')!.disabled).to.equal(false);
    await act(async () => typeInto(field(), ''));
    expect(makeGroup()).to.equal(null);

    // A file alone can become a document, but not a task or a journal line.
    const paste = pasteEvent({}, [png()]);
    await act(async () => field().dispatchEvent(paste));
    expect(button('New document from jot')!.disabled).to.equal(false);
    expect(button('New task from jot')!.disabled).to.equal(true);
    expect(button('Add jot to journal')!.disabled).to.equal(true);
    await act(async () => button('Remove venue.png')!.click());
    expect(makeGroup()).to.equal(null);
  });

  it('rests, faded by CSS, only while empty and idle', async () => {
    await render(actions());
    const resting = () =>
      container.querySelector('.db-quick-jot')!.classList.contains('db-quick-jot--resting');
    expect(resting()).to.equal(true);
    // Even blank space is something the person put there.
    await act(async () => typeInto(field(), ' '));
    expect(resting()).to.equal(false);
    await act(async () => typeInto(field(), ''));
    expect(resting()).to.equal(true);

    await act(async () => field().dispatchEvent(pasteEvent({}, [png()])));
    expect(resting()).to.equal(false);
    await act(async () => button('Remove venue.png')!.click());
    expect(resting()).to.equal(true);

    // Files dragged over it wake it.
    const section = container.querySelector('.db-quick-jot')!;
    await act(async () => {
      section.dispatchEvent(dragEvent('dragenter', []));
    });
    expect(resting()).to.equal(false);
    await act(async () => {
      section.dispatchEvent(dragEvent('dragleave', []));
    });
    expect(resting()).to.equal(true);

    // So does a message to read.
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          read: async () => {
            throw new DOMException('Denied', 'NotAllowedError');
          },
        },
      });
      await act(async () => button('Paste from clipboard')!.click());
      expect(status()).to.not.equal('');
      expect(resting()).to.equal(false);
    } finally {
      if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('puts keyboard focus back in the box when a used jot takes its buttons away', async () => {
    await render(actions({ task: true }));
    await act(async () => typeInto(field(), 'Call Priya'));
    const task = button('New task from jot')!;
    task.focus();
    const matches = task.matches.bind(task);
    // happy-dom cannot tell keyboard focus from a click's; this one came from Tab.
    task.matches = (selector: string) => selector === ':focus-visible' || matches(selector);
    await act(async () => task.click());
    expect(container.querySelector('[aria-label="Make the jot into"]')).to.equal(null);
    expect(document.activeElement).to.equal(field());
  });

  it('clears a used jot and keeps one that failed', async () => {
    await render(actions({ task: true }));
    expect(button('New task from jot')).to.equal(null);
    await act(async () => typeInto(field(), 'Call Priya tomorrow'));
    expect(status()).to.equal('As a task: due tomorrow');
    outcome = 'kept';
    await act(async () => button('New task from jot')!.click());
    expect(drafts.at(-1)?.action).to.equal('task');
    expect(field().value).to.equal('Call Priya tomorrow');
    outcome = 'used';
    await act(async () => button('New task from jot')!.click());
    expect(field().value).to.equal('');
  });

  it('makes a document with Cmd or Ctrl+Enter, and Enter alone starts a new line', async () => {
    await render(actions());
    await act(async () => typeInto(field(), 'Line one'));
    await act(async () => {
      field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(drafts).to.have.length(0);
    await act(async () => {
      field().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
      );
    });
    expect(drafts.map((entry) => [entry.action, entry.draft.text])).to.deep.equal([
      ['document', 'Line one'],
    ]);
  });

  it('turns pasted and dropped files into chips that go with the jot', async () => {
    await render(actions());
    const paste = pasteEvent({ 'text/html': '<img src="x">' }, [png()]);
    await act(async () => field().dispatchEvent(paste));
    expect(paste.defaultPrevented).to.equal(true);
    const section = container.querySelector('.db-quick-jot')!;
    await act(async () => {
      section.dispatchEvent(dragEvent('dragenter', []));
    });
    expect(section.classList.contains('db-quick-jot--dragging')).to.equal(true);
    await act(async () => {
      section.dispatchEvent(dragEvent('drop', [new File(['%PDF'], 'quote.pdf')]));
    });
    expect(section.classList.contains('db-quick-jot--dragging')).to.equal(false);
    // A drag from DocBlocks' own file list brings nothing new.
    await act(async () => {
      section.dispatchEvent(
        dragEvent('drop', [png('moved.png')], ['Files', 'application/x-docblocks-entry']),
      );
    });
    expect(chips()).to.deep.equal(['venue.png', 'quote.pdf']);

    // Files alone are enough for a document.
    expect(button('New document from jot')!.disabled).to.equal(false);
    await act(async () => button('Remove venue.png')!.click());
    expect(chips()).to.deep.equal(['quote.pdf']);

    outcome = 'text-used';
    await act(async () => typeInto(field(), 'Quote'));
    await act(async () => button('New document from jot')!.click());
    expect(drafts.at(-1)!.draft.attachments.map((a) => a.file.name)).to.deep.equal(['quote.pdf']);
    expect(field().value).to.equal('');
    expect(chips()).to.deep.equal(['quote.pdf']);
    expect(status()).to.match(/files are still here/);
  });

  it('lets a plain paste through untouched', async () => {
    await render(actions());
    const paste = pasteEvent({ 'text/plain': 'Price is $5' });
    await act(async () => field().dispatchEvent(paste));
    expect(paste.defaultPrevented).to.equal(false);
  });

  it('pastes from the clipboard at the caret, or says how to paste when it cannot', async () => {
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          read: async () => [{ types: ['text/plain'], getType: async () => new Blob(['pasted']) }],
        },
      });
      await render(actions());
      await act(async () => typeInto(field(), 'A  B'));
      field().setSelectionRange(2, 2);
      await act(async () => button('Paste from clipboard')!.click());
      expect(field().value).to.equal('A pasted B');

      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          read: async () => {
            throw new DOMException('Denied', 'NotAllowedError');
          },
        },
      });
      await act(async () => button('Paste from clipboard')!.click());
      expect(status()).to.match(/^DocBlocks can’t read the clipboard here\./);
    } finally {
      if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });
});

describe('createQuickJotActions', () => {
  const draft = (text: string, files: File[] = []): JotDraft => ({
    text,
    attachments: files.map((file, index) => ({
      id: `a${index}`,
      file,
      kind: file.type.startsWith('image/') ? 'image' : 'file',
    })),
  });

  function host(
    overrides: { saveNote?: string | null; task?: string | null; attach?: boolean } = {},
  ) {
    const calls: unknown[][] = [];
    const opened: string[] = [];
    const reports: string[] = [];
    const actions = createQuickJotActions({
      actions: {
        saveNote: async (text: string, title?: string, files: readonly AttachmentFile[] = []) => {
          calls.push(['saveNote', text, title, files.map((f) => f.name)]);
          return overrides.saveNote === undefined ? 'Unfiled/Note.md' : overrides.saveNote;
        },
        addDescribedTask: async (task: DescribedTask) => {
          calls.push(['task', task]);
          return overrides.task === undefined ? 'Tasks/Active/Call Priya.md' : overrides.task;
        },
        appendToJournal: async (text: string, options?: JournalAppendOptions) => {
          calls.push(['journal', text, options?.keepLines, options?.attachments?.length]);
          return true;
        },
        attach: async (path: string, files: readonly AttachmentFile[]) => {
          calls.push(['attach', path, files.length]);
          return overrides.attach ?? true;
        },
      },
      importToUnfiled: async (files) => {
        calls.push(['import', files.map((f) => f.name)]);
        return ['Unfiled/Brief.md'];
      },
      openDocument: (path) => opened.push(path),
      report: (kind, message) => reports.push(`${kind}: ${message}`),
      today: () => '2026-11-24',
      offersTask: true,
      offersJournal: true,
      toMarkdown: async (text) => `${text.trim()}\n`,
    });
    return { actions, calls, opened, reports };
  }

  it('saves a document to Unfiled, named from what was typed, and opens it', async () => {
    const { actions, calls, opened } = host();
    expect(await actions.toDocument(draft('Venue ideas\nThe barn', [png()]))).to.equal('used');
    expect(calls).to.deep.equal([
      ['saveNote', 'Venue ideas\nThe barn\n', 'Venue ideas', ['venue.png']],
    ]);
    expect(opened).to.deep.equal(['Unfiled/Note.md']);
  });

  it('imports Word, PDF or slides dropped alone, and keeps pictures alone as a note', async () => {
    const { actions, calls, opened } = host();
    expect(
      await actions.toDocument(draft('', [new File(['x'], 'Brief.docx', { type: '' })])),
    ).to.equal('used');
    expect(calls.at(-1)).to.deep.equal(['import', ['Brief.docx']]);
    expect(opened).to.deep.equal(['Unfiled/Brief.md']);
    await actions.toDocument(draft('', [png()]));
    expect(calls.at(-1)).to.deep.equal(['saveNote', '', undefined, ['venue.png']]);
  });

  it('makes a task from the first line, with notes, due date and files', async () => {
    const { actions, calls, reports } = host();
    expect(await actions.toTask!(draft('Call Priya tomorrow\nabout the venue', [png()]))).to.equal(
      'used',
    );
    expect(calls).to.deep.equal([
      ['task', { title: 'Call Priya', due: '2026-11-25', notes: 'about the venue' }],
      ['attach', 'Tasks/Active/Call Priya.md', 1],
    ]);
    expect(reports).to.deep.equal(['success: Added “Call Priya” to your tasks.']);
  });

  it('keeps the files when only the text could be used', async () => {
    const { actions } = host({ attach: false });
    expect(await actions.toTask!(draft('Call Priya', [png()]))).to.equal('text-used');
    const failed = host({ task: null });
    expect(await failed.actions.toTask!(draft('Call Priya'))).to.equal('kept');
  });

  it('adds a journal line that keeps its lines and files', async () => {
    const { actions, calls } = host();
    expect(await actions.toJournal!(draft('Walked\nthe dog', [png()]))).to.equal('used');
    expect(calls).to.deep.equal([['journal', 'Walked\nthe dog', true, 1]]);
    expect(await actions.toJournal!(draft('   ', [png()]))).to.equal('kept');
  });

  it('offers task and journal only when asked to', () => {
    const offered = createQuickJotActions({
      actions: {} as never,
      importToUnfiled: async () => [],
      openDocument: () => undefined,
      report: () => undefined,
      today: () => '2026-11-24',
      offersTask: false,
      offersJournal: false,
    });
    expect(Object.keys(offered)).to.deep.equal(['toDocument']);
  });
});
