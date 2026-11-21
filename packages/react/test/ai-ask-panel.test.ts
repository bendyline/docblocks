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
import { noteTitleFor, type WorkspaceAskSession } from '../src/Ai/workspace-ask.js';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const passage = {
  uri: 'knowledge://local/ws-1/garden/rose%20bed.md#line=3-9',
  title: 'Rose bed › Pests',
  text: 'Aphids cluster on new growth in May.',
};

function fakeAi() {
  const requests: AiChatRequest[] = [];
  const ai = {
    chat(request: AiChatRequest, onEvent: (event: AiChatEvent) => void) {
      requests.push(request);
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

  async function mount(ai = fakeAi().ai, notice: AskNotice | null = null) {
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
          }),
        }),
      );
    });
  }

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

  it('explains what stops a question and offers the step that allows it', async () => {
    let allowed = 0;
    await mount(fakeAi().ai, {
      kind: 'grounding-off',
      remote: true,
      onAllow: () => (allowed += 1),
    });
    expect(host.querySelector('.db-ai-ask-notice')?.textContent).to.contain('sent to it');
    expect(host.querySelector('textarea')?.disabled).to.equal(true);
    const allow = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Use this workspace in AI answers',
    );
    await act(async () => allow?.click());
    expect(allowed).to.equal(1);
  });

  it('names a note for its question', () => {
    expect(noteTitleFor('  What eats aphids? / roses  ')).to.equal('What eats aphids roses');
    expect(noteTitleFor('???')).to.equal('Answer');
  });
});
