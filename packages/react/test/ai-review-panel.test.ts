import { expect } from 'chai';
import * as React from 'react';
import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorProvider, useEditorContext } from '@bendyline/squisq-editor-react';
import type {
  AiChatCompletion,
  AiChatEvent,
  AiChatRequest,
  AiResult,
  DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';

import { AiReviewPanel } from '../src/Ai/AiEditorAssistant.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

const SOURCE = 'A very unique document.';
const REVIEW = JSON.stringify([
  {
    quote: 'very unique',
    replacement: 'distinctive',
    category: 'Clarity',
    severity: 'suggestion',
    message: 'Use a more precise phrase.',
    rationale: null,
  },
]);

function completion(text: string, finishReason: AiChatCompletion['finishReason'] = 'stop') {
  return {
    kind: 'done',
    completion: { text, finishReason, model: 'test-model', usage: null },
  } as const;
}

function unused(): never {
  throw new Error('Not used by the review panel');
}

function fakeAi() {
  const requests: {
    request: AiChatRequest;
    cancelled: boolean;
    emit(event: AiChatEvent): void;
  }[] = [];
  const api: DocBlocksHostAiAPI = {
    providerInstalled: unused,
    status: unused,
    onStatus: unused,
    getPreferences: unused,
    setPreferences: unused,
    connect: unused,
    disconnect: unused,
    models: unused,
    chat(request, onEvent) {
      let settle: (result: AiResult<AiChatCompletion>) => void = () => undefined;
      const done = new Promise<AiResult<AiChatCompletion>>((resolve) => {
        settle = resolve;
      });
      const recorded = {
        request,
        cancelled: false,
        emit(event: AiChatEvent) {
          onEvent(event);
          if (event.kind === 'done') settle({ ok: true, value: event.completion });
          if (event.kind === 'error') settle({ ok: false, error: event.error });
        },
      };
      requests.push(recorded);
      return {
        done,
        cancel() {
          recorded.cancelled = true;
        },
      };
    },
  };
  return { api, requests };
}

function EditDocument() {
  const { replaceAll } = useEditorContext();
  return createElement(
    'button',
    { onClick: () => replaceAll('Updated document.') },
    'Edit document',
  );
}

async function render(api: DocBlocksHostAiAPI, strict = true) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const content = createElement(EditorProvider, {
    initialMarkdown: SOURCE,
    children: [
      createElement(AiReviewPanel, { key: 'review', ai: api, onClose: () => undefined }),
      createElement(EditDocument, { key: 'edit' }),
    ],
  });
  await act(async () => {
    root.render(strict ? createElement(StrictMode, null, content) : content);
  });
  return {
    container,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function click(container: HTMLElement, label: string) {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === label,
  );
  expect(button, `button ${label}`).not.to.equal(undefined);
  await act(async () => button?.click());
}

describe('AiReviewPanel lifecycle', () => {
  it('finishes its automatic review after StrictMode effect replay and ignores the cancelled pass', async () => {
    const fake = fakeAi();
    const { container, cleanup } = await render(fake.api);
    try {
      expect(fake.requests).to.have.length(2);
      expect(fake.requests[0].cancelled).to.equal(true);
      expect(fake.requests[1].cancelled).to.equal(false);
      expect(fake.requests[1].request.purpose).to.equal('review');
      await act(async () => fake.requests[0].emit(completion('', 'cancelled')));
      expect(container.textContent).to.contain('Reviewing this document');
      expect(container.querySelector('[role="alert"]')).to.equal(null);

      await act(async () => fake.requests[1].emit(completion(REVIEW)));
      expect(container.textContent).to.contain('1 finding');
      expect(container.textContent).to.contain('Use a more precise phrase.');
      expect(container.textContent).not.to.contain('Reviewing this document');

      await click(container, 'Edit document');
      expect(fake.requests).to.have.length(2);
      expect(container.textContent).to.contain('The document changed after this review.');
    } finally {
      await cleanup();
    }
  });

  it('shows a provider failure after StrictMode effect replay instead of leaving the spinner', async () => {
    const fake = fakeAi();
    const { container, cleanup } = await render(fake.api);
    try {
      await act(async () =>
        fake.requests.at(-1)?.emit({
          kind: 'error',
          error: { code: 'timeout', message: 'The model stopped responding.' },
        }),
      );
      expect(container.querySelector('[role="alert"]')?.textContent).to.contain(
        'The model stopped responding.',
      );
      expect(container.textContent).not.to.contain('Reviewing this document');
      await click(container, 'Review again');
      await act(async () => fake.requests.at(-1)?.emit(completion('[]')));
      expect(container.textContent).to.contain('Nothing to report.');
    } finally {
      await cleanup();
    }
  });

  it('stops, retries and cancels the live review when the panel closes', async () => {
    const fake = fakeAi();
    const { container, cleanup } = await render(fake.api, false);
    try {
      expect(fake.requests).to.have.length(1);
      await act(async () =>
        fake.requests[0].emit({
          kind: 'progress',
          progress: { phase: 'prefill', percent: 50, outputTokens: null, tokensPerSecond: null },
        }),
      );
      expect(container.textContent).to.contain('Reviewing this document');
      await click(container, 'Stop review');
      expect(fake.requests[0].cancelled).to.equal(true);
      await act(async () => fake.requests[0].emit(completion(REVIEW, 'cancelled')));
      expect(container.querySelector('.db-ai-review-finding')).to.equal(null);
      await click(container, 'Review document');
      expect(fake.requests).to.have.length(2);
      expect(fake.requests[1].cancelled).to.equal(false);
    } finally {
      await cleanup();
    }
    expect(fake.requests[1].cancelled).to.equal(true);
  });
});
