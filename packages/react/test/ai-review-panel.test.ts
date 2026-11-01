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
  AiStatus,
  DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';

import { REVIEW_PASSES } from '../src/Ai/ai-assistant.js';
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

/** Apple's on-device model reports a 4,096-token context. */
const APPLE_CONTEXT = 4_096;

function fakeAi(contextWindow: number | null = 128_000) {
  const requests: {
    request: AiChatRequest;
    cancelled: boolean;
    emit(event: AiChatEvent): void;
  }[] = [];
  const status: AiStatus = {
    kind: 'ready',
    provider: { name: 'Fake', version: null, mode: 'installed' },
    model: { id: 'test-model', label: 'Test model', local: true, contextWindow, isDefault: true },
    activeRequests: 0,
  };
  const api: DocBlocksHostAiAPI = {
    providerInstalled: unused,
    status: async () => status,
    onStatus: () => () => undefined,
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

async function render(api: DocBlocksHostAiAPI, strict = true, markdown = SOURCE) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const content = createElement(EditorProvider, {
    initialMarkdown: markdown,
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

function buttonLabeled(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === label,
  );
}

async function click(container: HTMLElement, label: string) {
  const button = buttonLabeled(container, label);
  expect(button, `button ${label}`).not.to.equal(undefined);
  await act(async () => button?.click());
}

function styleList(container: HTMLElement) {
  const select = container.querySelector<HTMLSelectElement>('.db-ai-review-style select');
  expect(select, 'review style list').not.to.equal(null);
  return select as HTMLSelectElement;
}

async function chooseStyle(container: HTMLElement, style: string) {
  const select = styleList(container);
  await act(async () => {
    select.value = style;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function startReview(container: HTMLElement, style = 'general') {
  await chooseStyle(container, style);
  await click(container, 'Review document');
}

describe('AiReviewPanel lifecycle', () => {
  it('waits for a review style, then reviews once with that style', async () => {
    const fake = fakeAi();
    const { container, cleanup } = await render(fake.api);
    try {
      expect(fake.requests).to.have.length(0);
      expect(styleList(container).value).to.equal('');
      expect(container.textContent).to.contain('Choose a review style…');
      expect(buttonLabeled(container, 'Review document')?.disabled).to.equal(true);

      await chooseStyle(container, 'concise');
      // Choosing only describes the style; the button starts the review.
      expect(fake.requests).to.have.length(0);
      expect(container.textContent).to.contain('say the same thing in fewer words');
      expect(buttonLabeled(container, 'Review document')?.disabled).to.equal(false);

      await click(container, 'Review document');
      // One request even under StrictMode: nothing starts from an effect.
      expect(fake.requests).to.have.length(1);
      expect(fake.requests[0].request.purpose).to.equal('review');
      expect(fake.requests[0].request.messages[0]?.content).to.contain('in fewer words');
      expect(container.textContent).to.contain('Reviewing this document');
      expect(styleList(container).disabled).to.equal(true);

      await act(async () => fake.requests[0].emit(completion(REVIEW)));
      expect(container.querySelector('.db-ai-review-count')?.textContent).to.equal(
        '1 finding · Conciseness',
      );
      expect(container.textContent).to.contain('Use a more precise phrase.');
      expect(container.textContent).not.to.contain('Reviewing this document');
      expect(styleList(container).disabled).to.equal(false);

      await click(container, 'Edit document');
      expect(fake.requests).to.have.length(1);
      expect(container.textContent).to.contain('The document changed after this review.');

      // Another style is a new review, not a repeat of the last one.
      expect(buttonLabeled(container, 'Review again')).not.to.equal(undefined);
      await chooseStyle(container, 'facts');
      await click(container, 'Review document');
      expect(fake.requests).to.have.length(2);
      expect(fake.requests[1].request.messages[0]?.content).to.contain('Needs source');
    } finally {
      await cleanup();
    }
  });

  it('shows a provider failure instead of leaving the spinner', async () => {
    const fake = fakeAi();
    const { container, cleanup } = await render(fake.api);
    try {
      await startReview(container);
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

  it('keeps what a cut-off reply finished and asks again for the rest', async () => {
    const fake = fakeAi();
    const { container, cleanup } = await render(fake.api, false);
    try {
      await startReview(container);
      const cutOff = `${REVIEW.slice(0, -1)}, {"quote": "document", "replacement": "unfin`;
      await act(async () => fake.requests[0].emit(completion(cutOff, 'length')));
      // Shown while the follow-up runs, and named in it so it is not repeated.
      expect(container.textContent).to.contain('Use a more precise phrase.');
      expect(container.textContent).to.contain('Looking for more findings…');
      expect(container.querySelector('[role="alert"]')).to.equal(null);
      expect(fake.requests).to.have.length(2);
      const followUp = fake.requests[1].request.messages.at(-1)?.content ?? '';
      expect(followUp).to.contain('<document>\nA very unique document.\n</document>');
      expect(followUp).to.contain('Findings were already reported for these passages');
      expect(followUp).to.contain('- "very unique"');

      await act(async () => fake.requests[1].emit(completion('[]')));
      expect(container.querySelector('.db-ai-review-count')?.textContent).to.equal(
        '1 finding · General',
      );
      expect(container.textContent).not.to.contain('ran out of room');
    } finally {
      await cleanup();
    }
  });

  it('treats an unclosed review as cut off even when the host reports a normal stop', async () => {
    const fake = fakeAi();
    const { container, cleanup } = await render(fake.api, false);
    try {
      await startReview(container);
      // Gezel 1.1.2 reported Apple's replies cut off at 1,024 tokens as `stop`.
      const cutOff = `${REVIEW.slice(0, -1)}, {"quote": "document", "replacement": "unfin`;
      await act(async () => fake.requests[0].emit(completion(cutOff, 'stop')));
      expect(container.textContent).to.contain('Use a more precise phrase.');
      expect(fake.requests).to.have.length(2);
    } finally {
      await cleanup();
    }
  });

  it('says there may be more when asking again fails, and keeps what it has', async () => {
    const fake = fakeAi();
    const { container, cleanup } = await render(fake.api, false);
    try {
      await startReview(container);
      const cutOff = `${REVIEW.slice(0, -1)}, {"quote": "document", "replacement": "unfin`;
      await act(async () => fake.requests[0].emit(completion(cutOff, 'length')));
      await act(async () =>
        fake.requests[1].emit({
          kind: 'error',
          error: { code: 'timeout', message: 'The model stopped responding.' },
        }),
      );
      expect(container.querySelector('[role="alert"]')).to.equal(null);
      expect(container.textContent).to.contain('Use a more precise phrase.');
      expect(container.textContent).to.contain('The AI ran out of room after 1 finding');
    } finally {
      await cleanup();
    }
  });

  it('says a review was cut off, not unreadable, when no finding finished', async () => {
    const fake = fakeAi();
    const { container, cleanup } = await render(fake.api, false);
    try {
      await startReview(container);
      await act(async () =>
        fake.requests[0].emit(completion('[{"quote": "very unique", "repla', 'length')),
      );
      const alert = container.querySelector('[role="alert"]')?.textContent;
      expect(alert).to.contain('cut off before it finished a single finding');
      expect(alert).not.to.contain('Try reviewing again');

      await click(container, 'Review again');
      await act(async () => fake.requests.at(-1)?.emit(completion('{not json', 'stop')));
      expect(container.querySelector('[role="alert"]')?.textContent).to.contain(
        'could not read. Try reviewing again.',
      );
    } finally {
      await cleanup();
    }
  });

  it('stops, retries and cancels the live review when the panel closes', async () => {
    const fake = fakeAi();
    const { container, cleanup } = await render(fake.api, false);
    try {
      await startReview(container);
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

/** Long enough that a 4,096-token model reviews it in several parts. */
const LONG = [
  '# Quarterly report',
  ...Array.from(
    { length: 60 },
    (_, index) =>
      `${index % 15 === 0 ? `## Section ${index / 15 + 1}\n\n` : ''}Paragraph ${index + 1}: ` +
      'The team reviewed the plan and agreed on the next steps. '.repeat(6).trim(),
  ),
].join('\n\n');

function finding(quote: string, message: string): string {
  return JSON.stringify([
    { quote, replacement: null, category: 'Clarity', severity: 'info', message, rationale: null },
  ]);
}

/** The part a request carries, as "part 2 of 4", from its user message. */
function partOf(request: AiChatRequest): { part: number; of: number } | null {
  const match = /This is part (\d+) of (\d+)/u.exec(request.messages[1]?.content ?? '');
  return match ? { part: Number(match[1]), of: Number(match[2]) } : null;
}

/** `count` findings on distinct passages, `Passage <first>` onward. */
function findings(count: number, first = 1): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      quote: `Passage ${first + index}`,
      replacement: null,
      category: 'Clarity',
      severity: 'info',
      message: `Finding ${first + index}.`,
      rationale: null,
    })),
  );
}

describe('AiReviewPanel asking for more', () => {
  it('gets more than six findings from a small model by asking again while replies are full', async () => {
    const fake = fakeAi(APPLE_CONTEXT);
    const { container, cleanup } = await render(fake.api, false);
    try {
      await startReview(container);
      // Apple's reply holds about six, so a request asks for no more than that.
      expect(fake.requests[0].request.messages[0]?.content).to.contain('with at most 6 objects');
      await act(async () => fake.requests[0].emit(completion(findings(6, 1))));
      expect(container.textContent).to.contain('Looking for more findings…');

      // A small model asked for more repeats some; only the new ones are added.
      const repeated = JSON.stringify([
        ...JSON.parse(findings(3, 4)),
        ...JSON.parse(findings(3, 7)),
      ]);
      await act(async () => fake.requests[1].emit(completion(repeated)));
      const listed = fake.requests[2].request.messages.at(-1)?.content ?? '';
      for (let index = 1; index <= 9; index++) expect(listed).to.contain(`- "Passage ${index}"`);
      await act(async () => fake.requests[2].emit(completion(findings(2, 10))));

      expect(fake.requests).to.have.length(3);
      expect(container.querySelector('.db-ai-review-count')?.textContent).to.equal(
        '11 findings · General',
      );
      expect(container.querySelectorAll('.db-ai-review-item')).to.have.length(11);
      expect(container.textContent).not.to.contain('ran out of room');
    } finally {
      await cleanup();
    }
  });

  it('stops asking when a reply adds nothing new, or after a few passes', async () => {
    const fake = fakeAi(APPLE_CONTEXT);
    const { container, cleanup } = await render(fake.api, false);
    try {
      await startReview(container);
      await act(async () => fake.requests[0].emit(completion(findings(6, 1))));
      await act(async () => fake.requests[1].emit(completion(findings(6, 1))));
      expect(fake.requests).to.have.length(2);
      expect(container.querySelector('.db-ai-review-count')?.textContent).to.equal(
        '6 findings · General',
      );

      // A model that always fills its reply with new findings is stopped.
      await click(container, 'Review again');
      for (let pass = 0; pass < REVIEW_PASSES; pass++) {
        await act(async () => fake.requests.at(-1)?.emit(completion(findings(6, pass * 6 + 1))));
      }
      expect(fake.requests).to.have.length(2 + REVIEW_PASSES);
      expect(container.querySelector('.db-ai-review-count')?.textContent).to.equal(
        `${REVIEW_PASSES * 6} findings · General`,
      );
      expect(container.textContent).to.contain('The AI ran out of room');
    } finally {
      await cleanup();
    }
  });
});

describe('AiReviewPanel in parts', () => {
  it('reviews a long document part by part on a small model, showing findings as they come', async () => {
    const fake = fakeAi(APPLE_CONTEXT);
    const { container, cleanup } = await render(fake.api, true, LONG);
    try {
      await startReview(container);
      expect(fake.requests).to.have.length(1);
      const first = partOf(fake.requests[0].request);
      expect(first?.part).to.equal(1);
      const parts = first?.of ?? 0;
      expect(parts).to.be.greaterThan(1);
      expect(container.textContent).to.contain(`Reviewing part 1 of ${parts}…`);

      // Two parts each number their one finding 1; both must stay listed.
      await act(async () => fake.requests[0].emit(completion(finding('Paragraph 1:', 'First.'))));
      expect(fake.requests).to.have.length(2);
      expect(container.textContent).to.contain('First.');
      expect(container.textContent).to.contain(`Reviewing part 2 of ${parts}…`);
      const second = fake.requests[1].request.messages[1]?.content ?? '';
      const quote = /Paragraph \d+:/u.exec(second)?.[0] ?? '';
      await act(async () => fake.requests[1].emit(completion(finding(quote, 'Second.'))));
      for (let index = 2; index < parts; index++) {
        await act(async () => fake.requests[index].emit(completion('[]')));
      }
      expect(fake.requests).to.have.length(parts);
      expect(container.querySelector('.db-ai-review-count')?.textContent).to.equal(
        '2 findings · General',
      );

      // Every paragraph went to exactly one part, and no part overran the window.
      const sent = fake.requests.map(({ request }) =>
        request.messages.map((message) => message.content).join('\n'),
      );
      for (let index = 1; index <= 60; index++) {
        const marker = `Paragraph ${index}:`;
        expect(
          sent.filter((text) => text.includes(marker)),
          marker,
        ).to.have.length(1);
      }
      for (const text of sent) expect(text.length / 3 + 1_200).to.be.below(APPLE_CONTEXT);

      await click(container, 'Dismiss');
      expect(container.textContent).not.to.contain('First.');
      expect(container.textContent).to.contain('Second.');
    } finally {
      await cleanup();
    }
  });

  it('sends the whole document at once to a model with room for it', async () => {
    const fake = fakeAi(128_000);
    const { container, cleanup } = await render(fake.api, false, LONG);
    try {
      await startReview(container);
      expect(partOf(fake.requests[0].request)).to.equal(null);
      expect(fake.requests[0].request.messages[1]?.content).to.contain('Paragraph 60:');
      expect(container.textContent).to.contain('Reviewing this document…');
    } finally {
      await cleanup();
    }
  });

  it('stops between parts, keeps what it found, and continues where it stopped', async () => {
    const fake = fakeAi(APPLE_CONTEXT);
    const { container, cleanup } = await render(fake.api, false, LONG);
    try {
      await startReview(container);
      const parts = partOf(fake.requests[0].request)?.of ?? 0;
      await act(async () => fake.requests[0].emit(completion(finding('Paragraph 1:', 'First.'))));
      await click(container, 'Stop review');
      expect(fake.requests[1].cancelled).to.equal(true);
      // The cancelled part's late reply changes nothing.
      await act(async () =>
        fake.requests[1].emit(completion(finding('Paragraph 2:', 'Late.'), 'cancelled')),
      );
      expect(container.textContent).to.contain(`Stopped after 1 of ${parts} parts`);
      expect(container.textContent).to.contain('First.');
      expect(container.textContent).not.to.contain('Late.');
      expect(container.querySelector('.db-ai-review-count')?.textContent).to.equal(
        '1 finding · General',
      );
      const buttons = Array.from(container.querySelectorAll('.db-ai-review-buttons button'));
      expect(buttons.map((button) => button.textContent)).to.deep.equal([
        'Continue review',
        'Start over',
      ]);

      await click(container, 'Continue review');
      expect(fake.requests).to.have.length(3);
      expect(partOf(fake.requests[2].request)?.part).to.equal(2);
      expect(fake.requests[2].request).to.deep.equal(fake.requests[1].request);
      expect(container.textContent).to.contain(`Reviewing part 2 of ${parts}…`);

      // Another style is a fresh review, so it cannot pick up this one.
      await click(container, 'Stop review');
      await chooseStyle(container, 'concise');
      expect(buttonLabeled(container, 'Continue review')).to.equal(undefined);
      await click(container, 'Review document');
      expect(partOf(fake.requests.at(-1)?.request as AiChatRequest)?.part).to.equal(1);
      expect(container.textContent).not.to.contain('First.');
    } finally {
      await cleanup();
    }
  });

  it('pauses on a failed part and lets it be retried or skipped', async () => {
    const fake = fakeAi(APPLE_CONTEXT);
    const { container, cleanup } = await render(fake.api, false, LONG);
    try {
      await startReview(container);
      const parts = partOf(fake.requests[0].request)?.of ?? 0;
      await act(async () => fake.requests[0].emit(completion(finding('Paragraph 1:', 'First.'))));
      const failure: AiChatEvent = {
        kind: 'error',
        error: { code: 'timeout', message: 'The model stopped responding.' },
      };
      await act(async () => fake.requests[1].emit(failure));
      expect(container.querySelector('[role="alert"]')?.textContent).to.equal(
        `Part 2 of ${parts} could not be reviewed. The model stopped responding.`,
      );
      expect(container.textContent).to.contain('First.');
      expect(
        Array.from(container.querySelectorAll('.db-ai-review-buttons button')).map(
          (button) => button.textContent,
        ),
      ).to.deep.equal(['Retry part 2', 'Skip part 2', 'Start over']);

      await click(container, 'Retry part 2');
      expect(fake.requests).to.have.length(3);
      expect(fake.requests[2].request).to.deep.equal(fake.requests[1].request);
      await act(async () => fake.requests[2].emit(failure));

      await click(container, 'Skip part 2');
      expect(partOf(fake.requests[3].request)?.part).to.equal(3);
      for (let index = 3; index < fake.requests.length; index++) {
        await act(async () => fake.requests[index].emit(completion('[]')));
      }
      expect(fake.requests).to.have.length(parts + 1);
      expect(container.querySelector('[role="alert"]')).to.equal(null);
      expect(container.textContent).to.contain('Part 2 was skipped');
      expect(container.querySelector('.db-ai-review-count')?.textContent).to.equal(
        '1 finding · General',
      );
    } finally {
      await cleanup();
    }
  });
});

describe('AiReviewPanel showing a finding in the document', () => {
  it('marks the finding shown, and says when its text changed after the review', async () => {
    const fake = fakeAi();
    const { container, cleanup } = await render(fake.api, false);
    try {
      await startReview(container);
      await act(async () => fake.requests[0].emit(completion(REVIEW)));
      const card = container.querySelector<HTMLElement>('.db-ai-review-item');
      const note = () => container.querySelector('.db-ai-review-locate-note')?.textContent ?? null;

      await click(container, 'Show in document');
      expect(card?.classList.contains('db-ai-review-item--shown')).to.equal(true);
      expect(note()).to.equal(null);

      // "very unique" is gone; the words after it still place it.
      await click(container, 'Edit document');
      await act(async () => card?.querySelector('h3')?.click());
      expect(note()).to.equal(
        'This text has changed since the review. Its closest match is selected.',
      );
    } finally {
      await cleanup();
    }
  });
});

describe('AiReviewPanel output report', () => {
  it('reports the review from inside the app, including the response only when asked', async () => {
    const fake = fakeAi();
    const { container, cleanup } = await render(fake.api, false);
    const opened: string[] = [];
    const open = window.open;
    window.open = ((url?: string | URL) => {
      opened.push(String(url));
      return null;
    }) as typeof window.open;
    try {
      await startReview(container);
      expect(container.textContent).not.to.contain('Report output');
      await act(async () => fake.requests[0].emit(completion(REVIEW)));
      await click(container, 'Report output');
      const dialog = document.body.querySelector('[role="dialog"]');
      expect(dialog?.textContent).to.contain('Report AI output');
      expect(dialog?.textContent).to.contain('GitHub issues are public');
      await click(document.body, 'Open Public Issue on GitHub');
      const withoutResponse = new URL(opened[0]).searchParams.get('body') ?? '';
      // The style says which prompt produced the output being reported.
      expect(withoutResponse).to.contain('- Feature: Review document (General)');
      expect(withoutResponse).to.contain('- Model: test-model');
      expect(withoutResponse).not.to.contain('Use a more precise phrase.');
      expect(document.body.querySelector('[role="dialog"]')).to.equal(null);

      await click(container, 'Report output');
      const include = document.body.querySelector<HTMLInputElement>(
        '[role="dialog"] input[type="checkbox"]',
      );
      await act(async () => include?.click());
      await click(document.body, 'Open Public Issue on GitHub');
      const withResponse = new URL(opened[1]).searchParams.get('body') ?? '';
      expect(withResponse).to.contain('suggestion · Clarity: Use a more precise phrase.');
      expect(withResponse).to.contain('Suggested: distinctive');

      await click(container, 'Report output');
      await click(document.body, 'Send report e-mail');
      const email = new URL(opened[2]);
      expect(email.protocol).to.equal('mailto:');
      expect(email.pathname).to.equal('support@bendyline.com');
      expect(email.searchParams.get('body')).to.contain('- Feature: Review document');
      expect(email.searchParams.get('body')).not.to.contain('Use a more precise phrase.');
      expect(document.body.querySelector('[role="dialog"]')).to.equal(null);
    } finally {
      window.open = open;
      await cleanup();
    }
  });
});
