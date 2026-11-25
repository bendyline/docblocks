import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorProvider } from '@bendyline/squisq-editor-react';
import type {
  AiChatEvent,
  AiChatRequest,
  DocBlocksHostAiAPI,
  WorkspacePassageReference,
} from '@bendyline/docblocks/host';

import { AiAskPanel, type AskNotice } from '../src/Ai/AiAskPanel.js';
import type { AskChats } from '../src/Ai/AskChatList.js';
import type { AskActions } from '../src/Ai/ask-proposals.js';
import type { ProposedAction } from '../src/Ai/chat-actions.js';
import { noteTitleFor, type WorkspaceAskSession } from '../src/Ai/workspace-ask.js';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const passage = {
  uri: 'knowledge://local/ws-1/garden/rose%20bed.md#line=3-9',
  title: 'Rose bed › Pests',
  text: 'Aphids cluster on new growth in May.',
};

function fakeAi(suggestions = '{"actions":[]}') {
  const requests: AiChatRequest[] = [];
  const ai = {
    chat(request: AiChatRequest, onEvent: (event: AiChatEvent) => void) {
      requests.push(request);
      if (request.responseFormat) {
        return {
          done: Promise.resolve({
            ok: true as const,
            value: { text: suggestions, model: 'm', finishReason: 'stop' as const, usage: null },
          }),
          cancel: () => undefined,
        };
      }
      onEvent({
        kind: 'knowledge',
        knowledge: {
          outcome: 'used',
          sources: [{ catalogId: 'ws-1', name: 'This workspace', titles: [passage.title] }],
          evidence: [
            { title: passage.title, catalogId: 'ws-1', text: passage.text, uri: passage.uri },
          ],
        },
      });
      onEvent({ kind: 'delta', text: 'Aphids arrive in May [1].' });
      return {
        done: Promise.resolve({
          ok: true as const,
          value: {
            text: 'Aphids arrive in May [1].',
            model: 'm',
            finishReason: 'stop' as const,
            usage: null,
          },
        }),
        cancel: () => undefined,
      };
    },
  } as unknown as Pick<DocBlocksHostAiAPI, 'chat' | 'checkFacts'>;
  return { ai, requests };
}

describe('AiAskPanel', () => {
  let host: HTMLDivElement;
  let root: Root;
  const holder: { current: WorkspaceAskSession | null } = { current: null };
  const opened: Array<{ reference: WorkspacePassageReference; passage: string }> = [];
  const saved: Array<{ title: string; markdown: string }> = [];

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    holder.current = null;
    opened.length = 0;
    saved.length = 0;
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function mount(
    ai = fakeAi().ai,
    notice: AskNotice | null = null,
    actions?: AskActions,
    chats?: AskChats,
  ) {
    await act(async () => {
      root.render(
        createElement(EditorProvider, {
          initialMarkdown: '# Journal\n',
          children: createElement(AiAskPanel, {
            sessionHolder: holder,
            ai,
            findPassages: async () => [passage],
            notice,
            coverage: null,
            onOpenNote: (reference, text) => opened.push({ reference, passage: text }),
            onSaveNote: async (title, markdownFor) => {
              saved.push({ title, markdown: markdownFor(`${title}.md`) });
            },
            onClose: () => undefined,
            ...(actions ? { actions } : {}),
            ...(chats ? { chats } : {}),
          }),
        }),
      );
    });
  }

  const button = (label: string) =>
    [...host.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

  async function ask(question: string) {
    const field = host.querySelector('textarea')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(field, question);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      host.querySelector<HTMLFormElement>('form')!.requestSubmit();
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }

  it('answers from the notes and opens the one a citation names', async () => {
    const { ai, requests } = fakeAi();
    await mount(ai);
    await ask('When do aphids come?');
    expect(requests[0]?.workspacePassages).to.deep.equal([passage]);
    expect(host.querySelector('.db-ai-ask-question')?.textContent).to.equal('When do aphids come?');
    expect(host.querySelector('.db-ai-ask-answer')?.textContent).to.equal('Aphids arrive in May1.');
    const cite = host.querySelector<HTMLButtonElement>('button.db-ai-ask-cite');
    expect(cite?.getAttribute('aria-label')).to.equal('Source 1: Rose bed › Pests. Open the note.');
    await act(async () => cite?.click());
    expect(opened).to.deep.equal([
      {
        reference: { catalogId: 'ws-1', path: 'garden/rose bed.md', lineStart: 3, lineEnd: 9 },
        passage: passage.text,
      },
    ]);
  });

  it('saves an answer as a note whose footnote links the cited note', async () => {
    await mount();
    await ask('When do aphids come?');
    const save = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Save as note',
    );
    await act(async () => save?.click());
    expect(saved).to.deep.equal([
      {
        title: 'When do aphids come',
        markdown:
          '# When do aphids come\n\nAphids arrive in May[^source-1].\n\n' +
          '[^source-1]: [Rose bed › Pests](garden/rose%20bed.md), a note in this workspace.\n',
      },
    ]);
  });

  it('keeps the conversation when the panel remounts with the editor', async () => {
    await mount();
    await ask('When do aphids come?');
    await act(async () => root.render(createElement('div')));
    await mount();
    expect(host.querySelector('.db-ai-ask-question')?.textContent).to.equal('When do aphids come?');
  });

  it('explains why answers do not draw on notes, and chats all the same', async () => {
    let allowed = 0;
    const { ai, requests } = fakeAi();
    await mount(ai, {
      kind: 'grounding-off',
      remote: true,
      onAllow: () => (allowed += 1),
    });
    expect(host.querySelector('.db-ai-ask-notice')?.textContent).to.contain('sent to it');
    expect(host.querySelector('textarea')?.disabled).to.equal(false);
    const allow = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Use this workspace in AI answers',
    );
    await act(async () => allow?.click());
    expect(allowed).to.equal(1);
    await ask('hi');
    expect(requests).to.have.length(1);
    expect(host.querySelector('.db-ai-ask-answer')).to.not.equal(null);
  });

  it('lists saved chats behind the Chats button, and opens, renames and deletes them', async () => {
    const calls: string[] = [];
    const chats: AskChats = {
      items: [
        { path: 'Chats/Aphids.md' as never, title: 'Aphids', lastModified: '2026-11-24T10:00:00Z' },
      ],
      workspaceId: 'w',
      onOpen: (path) => calls.push(`open ${path}`),
      onRename: async (path, title) => {
        calls.push(`rename ${path} ${title}`);
        return true;
      },
      onDelete: (path) => calls.push(`delete ${path}`),
    };
    await mount(fakeAi().ai, null, undefined, chats);
    expect(host.querySelector('.db-ai-ask-chats')).to.equal(null);
    await act(async () => button('Chats')?.click());
    expect(host.querySelector('.db-ai-ask-chat-title')?.textContent).to.equal('Aphids');
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="Delete Aphids"]')!.click(),
    );
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="Rename Aphids"]')!.click(),
    );
    const field = host.querySelector<HTMLInputElement>('.db-ai-ask-chat-rename input')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(field, 'Garden pests');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => field.form!.requestSubmit());
    await act(async () => host.querySelector<HTMLButtonElement>('.db-ai-ask-chat-open')!.click());
    expect(calls).to.deep.equal([
      'delete Chats/Aphids.md',
      'rename Chats/Aphids.md Garden pests',
      'open Chats/Aphids.md',
    ]);
    // Opening one returns to the conversation.
    expect(host.querySelector('.db-ai-ask-chats')).to.equal(null);
  });

  it('suggests tasks after an answer and does each only once confirmed', async () => {
    const { ai, requests } = fakeAi(
      JSON.stringify({
        actions: [
          { type: 'create_task', title: 'Spray the roses', due: '2026-05-01' },
          { type: 'append_to_document', path: 'garden/rose bed.md', markdown: 'Sprayed.' },
        ],
      }),
    );
    const run: ProposedAction[] = [];
    const openedPaths: string[] = [];
    await mount(ai, null, {
      run: async (action) => {
        run.push(action);
        return { path: 'Tasks/Active/Spray the roses.md' };
      },
      open: (path) => openedPaths.push(path),
    });
    await ask('When do aphids come?');
    await act(async () => button('Suggest tasks and notes')?.click());
    await settle();
    // Edits were not allowed, so only the task is offered, and nothing has run yet.
    expect(requests[1]?.responseFormat?.name).to.equal('docblocks_actions');
    const cards = host.querySelectorAll('.db-ai-proposal');
    expect(
      [...cards].map((card) => card.querySelector('.db-ai-proposal-what')?.textContent),
    ).to.deep.equal(['New task “Spray the roses”, due 2026-05-01']);
    expect(run).to.deep.equal([]);
    await act(async () => button('Do it')?.click());
    await settle();
    expect(run).to.deep.equal([
      { kind: 'create-task', title: 'Spray the roses', due: '2026-05-01' },
    ]);
    expect(host.querySelector('.db-ai-proposal')?.getAttribute('data-state')).to.equal('done');
    await act(async () => button('Open')?.click());
    expect(openedPaths).to.deep.equal(['Tasks/Active/Spray the roses.md']);
  });

  it('offers edits to cited notes only after they are allowed', async () => {
    const { ai, requests } = fakeAi(
      JSON.stringify({
        actions: [{ type: 'append_to_document', path: 'garden/rose bed.md', markdown: 'Sprayed.' }],
      }),
    );
    await mount(ai, null, {
      run: async () => ({ path: 'garden/rose bed.md' }),
      open: () => undefined,
    });
    await ask('When do aphids come?');
    const allow = host.querySelector<HTMLInputElement>('.db-ai-ask-allow input')!;
    await act(async () => allow.click());
    await act(async () => button('Suggest tasks, notes and edits')?.click());
    await settle();
    expect(requests[1]?.messages[1]?.content).to.contain('- garden/rose bed.md (Rose bed › Pests)');
    const card = host.querySelector('.db-ai-proposal');
    expect(card?.classList.contains('db-ai-proposal--edit')).to.equal(true);
    expect(button('Make this change')).not.to.equal(undefined);
    // A new conversation starts with edits not allowed.
    await act(async () => button('New chat')?.click());
    expect(host.querySelector<HTMLInputElement>('.db-ai-ask-allow input')?.checked).to.equal(false);
  });

  it('offers no suggestions where the shell cannot carry them out', async () => {
    await mount();
    await ask('When do aphids come?');
    expect(button('Suggest tasks and notes')).to.equal(undefined);
    expect(host.querySelector('.db-ai-ask-allow')).to.equal(null);
  });

  it('names a note for its question', () => {
    expect(noteTitleFor('  What eats aphids? / roses  ')).to.equal('What eats aphids roses');
    expect(noteTitleFor('???')).to.equal('Answer');
  });
});
