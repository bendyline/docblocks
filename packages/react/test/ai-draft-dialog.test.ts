import { expect } from 'chai';
import * as React from 'react';
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { EditorSelectionInfo } from '@bendyline/squisq-editor-react';
import type {
  AiChatCompletion,
  AiChatEvent,
  AiChatRequest,
  AiModelInfo,
  AiResult,
  DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';

import { AiDraftDialog } from '../src/Ai/AiEditorAssistant.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

function completion(text: string, finishReason: AiChatCompletion['finishReason'] = 'stop') {
  return {
    kind: 'done',
    completion: { text, finishReason, model: 'test-model', usage: null },
  } as const;
}

function unused(): never {
  throw new Error('Not used by the draft dialog');
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

function button(label: string, parent: ParentNode = document.body) {
  const found = Array.from(parent.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function click(label: string, parent?: ParentNode) {
  await act(async () => {
    const target = button(label, parent);
    target.focus();
    target.click();
  });
}

function field(selector: string) {
  const found = document.querySelector<HTMLTextAreaElement>(selector);
  if (!found) throw new Error(`Missing field: ${selector}`);
  return found;
}

const prompt = () => field('.db-ai-field textarea');
const output = () => field('.db-ai-draft-output');

async function type(field: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      field,
      value,
    );
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('AiDraftDialog', () => {
  let container: HTMLDivElement;
  let root: Root;
  let fake: ReturnType<typeof fakeAi>;
  let applied: string[];
  let closed: number;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    fake = fakeAi();
    applied = [];
    closed = 0;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(
    mode: 'compose' | 'rewrite' = 'rewrite',
    options: {
      text?: string;
      markdown?: string;
      model?: AiModelInfo;
      getSelection?: () => EditorSelectionInfo | null;
    } = {},
  ) {
    const source = options.text ?? 'Original passage.';
    const selection: EditorSelectionInfo = {
      view: 'write',
      text: mode === 'rewrite' ? source : '',
      ...(options.markdown === undefined ? {} : { markdown: options.markdown }),
      empty: mode === 'compose',
    };
    await act(async () => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(AiDraftDialog, {
            ai: fake.api,
            model: options.model,
            mode,
            documentSource: source,
            capturedSelection: selection,
            getSelection: options.getSelection ?? (() => selection),
            replaceSelection: (markdown) => {
              applied.push(markdown);
              return true;
            },
            onClose: () => {
              closed += 1;
            },
          }),
        ),
      );
    });
  }

  async function finish(text = 'Generated **draft**.') {
    await act(async () => fake.requests.at(-1)?.emit(completion(text)));
  }

  it('sends selected Markdown to the model while keeping the selection preview readable', async () => {
    const markdown = '## Advice {[factCard]}\n\nKeep **formatting**.';
    await render('rewrite', { text: 'Advice\nKeep formatting.', markdown });
    expect(document.querySelector('.db-ai-selection-preview')?.textContent).to.contain(
      'Keep formatting.',
    );
    expect(document.querySelector('.db-ai-selection-preview')?.textContent).not.to.contain(
      '{[factCard]}',
    );
    await click('Generate');
    expect(fake.requests[0].request.messages[1].content).to.contain(
      `<selection>\n${markdown}\n</selection>`,
    );
    await finish(markdown);
    await click('Replace selection');
    expect(applied).to.deep.equal([markdown]);
  });

  it('does not replace a selection whose block metadata changed while the dialog was open', async () => {
    await render('rewrite', {
      text: 'Advice',
      markdown: '## Advice {[factCard]}',
      getSelection: () => ({
        view: 'write',
        text: 'Advice',
        markdown: '## Advice {[quote]}',
        empty: false,
      }),
    });
    await click('Generate');
    await finish('## Revised advice {[factCard]}');
    await click('Replace selection');
    expect(applied).to.deep.equal([]);
    expect(document.body.textContent).to.contain('The selected text changed');
  });

  it('continues from an edited cut-off word, preserves whitespace and protects carried edits', async () => {
    await render();
    await click('Generate');
    await act(async () => fake.requests[0].emit(completion('A para', 'length')));
    expect(document.body.textContent).to.contain('Draft incomplete');
    expect(applied).to.deep.equal([]);
    await type(output(), 'An edited para');
    await type(prompt(), 'A different task for a future regeneration.');
    await click('Continue draft');
    expect(output().value).to.equal('An edited para');
    expect(output().readOnly).to.equal(true);
    expect(fake.requests[1].request.messages.slice(0, -2)).to.deep.equal(
      fake.requests[0].request.messages,
    );
    expect(fake.requests[1].request.messages.at(-2)).to.deep.equal({
      role: 'assistant',
      content: 'An edited para',
    });
    expect(fake.requests[1].request).not.to.have.property('maxTokens');
    await act(async () => fake.requests[1].emit({ kind: 'delta', text: 'graph.\n\n' }));
    expect(output().value).to.equal('An edited paragraph.\n\n');
    await act(async () => fake.requests[1].emit(completion('graph.\n\n', 'length')));
    await click('Continue draft');
    expect(fake.requests[2].request.messages).to.have.length(
      fake.requests[0].request.messages.length + 2,
    );
    expect(fake.requests[2].request.messages.at(-2)?.content).to.equal('An edited paragraph.\n\n');
    await finish(' A final line.');
    expect(output().value).to.equal('An edited paragraph.\n\n A final line.');
    expect(
      Array.from(document.querySelectorAll('button')).some(
        (item) => item.textContent === 'Continue draft',
      ),
    ).to.equal(false);
    await click('Regenerate');
    expect(fake.requests).to.have.length(3);
    expect(document.body.textContent).to.contain(
      'This will remove all edits you have made. Continue?',
    );
    await click('Cancel', document.querySelectorAll('[role="dialog"]')[1]);
    await click('Replace selection');
    expect(applied).to.deep.equal(['An edited paragraph.\n\n A final line.']);
  });

  for (const mode of ['compose', 'rewrite'] as const) {
    it(`requires explicit confirmation to apply an incomplete ${mode} draft`, async () => {
      await render(mode);
      await click('Generate');
      await act(async () => fake.requests[0].emit(completion('Unfinished sentence', 'length')));
      const applyLabel = mode === 'rewrite' ? 'Replace selection' : 'Insert';
      await click(applyLabel);
      const confirmation = document.querySelectorAll<HTMLElement>('[role="dialog"]')[1];
      expect(confirmation.textContent).to.contain('This draft did not finish.');
      expect(applied).to.deep.equal([]);
      expect(
        document.activeElement ===
          button(mode === 'rewrite' ? 'Cancel' : 'Insert anyway', confirmation),
      ).to.equal(true);
      await click('Cancel', confirmation);
      expect(output().value).to.equal('Unfinished sentence');
      expect(closed).to.equal(0);
      await click(applyLabel);
      await click(mode === 'rewrite' ? 'Replace anyway' : 'Insert anyway');
      expect(applied).to.deep.equal(['Unfinished sentence']);
      expect(closed).to.equal(1);
    });
  }

  for (const ending of ['error', 'cancelled', 'empty'] as const) {
    it(`preserves a recoverable draft after a continuation ends with ${ending}`, async () => {
      await render();
      await click('Generate');
      await act(async () => fake.requests[0].emit(completion('First part ', 'length')));
      await click('Continue draft');
      if (ending !== 'empty') {
        await act(async () => fake.requests[1].emit({ kind: 'delta', text: 'next' }));
      }
      await act(async () =>
        fake.requests[1].emit(
          ending === 'error'
            ? { kind: 'error', error: { code: 'timeout', message: 'Request timed out.' } }
            : completion(
                ending === 'empty' ? '' : 'next',
                ending === 'empty' ? 'stop' : 'cancelled',
              ),
        ),
      );
      expect(output().value).to.equal(ending === 'empty' ? 'First part ' : 'First part next');
      expect(output().readOnly).to.equal(false);
      expect(button('Continue draft').disabled).to.equal(false);
      expect(applied).to.deep.equal([]);
    });
  }

  it('warns upfront using the selected model and still lets the user generate', async () => {
    await render('rewrite', {
      text: 'A long passage. '.repeat(500),
      model: {
        id: 'mlx:selected-writer',
        label: 'Selected Writer',
        local: true,
        isDefault: true,
        contextWindow: 4096,
      },
    });
    expect(document.body.textContent).to.contain("Selected Writer's reported 4,096-token context");
    expect(document.body.textContent).to.contain('size estimate');
    await click('Generate anyway');
    expect(fake.requests[0].request.model).to.equal('mlx:selected-writer');
  });

  it('preserves an oversized draft but blocks a continuation too large to send', async () => {
    await render();
    await click('Generate');
    await act(async () => fake.requests[0].emit(completion('Partial.', 'length')));
    const largeDraft = 'x'.repeat(262_144);
    await type(output(), largeDraft);
    expect(button('Continue draft').disabled).to.equal(true);
    expect(output().value).to.equal(largeDraft);
    expect(output().readOnly).to.equal(false);
    expect(document.body.textContent).to.contain('exceed the request size');
    expect(fake.requests).to.have.length(1);
  });

  it('offers useful guidance when a limit is reached before any draft arrives', async () => {
    await render();
    await click('Generate');
    await act(async () => fake.requests[0].emit(completion('', 'length')));
    expect(document.body.textContent).to.contain('before producing a draft');
    expect(button('Replace selection').disabled).to.equal(true);
    expect(
      Array.from(document.querySelectorAll('button')).some(
        (item) => item.textContent === 'Continue draft',
      ),
    ).to.equal(false);
  });

  for (const mode of ['compose', 'rewrite'] as const) {
    it(`uses the ${mode} placeholder when the prompt is blank and initially shows only Generate`, async () => {
      await render(mode);
      expect(prompt().value).to.equal('');
      expect(prompt().placeholder).to.equal(
        mode === 'compose'
          ? 'Add a concise introduction for this document.'
          : 'Improve clarity and flow while preserving the meaning and voice.',
      );
      expect(document.activeElement).to.equal(prompt());
      expect(document.querySelector('.db-ai-draft-output')).to.equal(null);
      expect(document.querySelector('.db-ai-draft-body')?.contains(button('Generate'))).to.equal(
        true,
      );
      expect(button(mode === 'compose' ? 'Insert' : 'Replace selection').disabled).to.equal(true);
      expect(fake.requests).to.have.length(0);

      await type(prompt(), '   ');
      await click('Generate');
      expect(fake.requests[0].request.messages.at(-1)?.content).to.contain(
        `Instructions:\n${prompt().placeholder}\n`,
      );
      expect(output().readOnly).to.equal(true);
      await finish();
      expect(output().readOnly).to.equal(false);
    });

    it(`uses custom instructions and inserts the edited ${mode} draft`, async () => {
      await render(mode);
      await type(prompt(), 'Make it concise.');
      expect(prompt().value).to.equal('Make it concise.');
      await click('Generate');
      expect(fake.requests[0].request.messages.at(-1)?.content).to.contain(
        'Instructions:\nMake it concise.\n',
      );
      await finish();
      await type(output(), 'My **edited** response.');
      await click(mode === 'compose' ? 'Insert' : 'Replace selection');
      expect(applied).to.deep.equal(['My **edited** response.']);
      expect(closed).to.equal(1);
    });
  }

  it('preserves edits on cancellation and replaces them only after confirmation', async () => {
    await render();
    await click('Generate');
    await finish();
    await type(output(), 'My changes.');
    await click('Regenerate');
    const confirmation = document.querySelectorAll<HTMLElement>('[role="dialog"]')[1];
    expect(confirmation.textContent).to.contain(
      'This will remove all edits you have made. Continue?',
    );
    expect(document.activeElement).to.equal(button('Cancel', confirmation));
    expect(fake.requests).to.have.length(1);
    await click('Cancel', confirmation);
    expect(output().value).to.equal('My changes.');
    expect(document.activeElement).to.equal(button('Regenerate'));

    await click('Regenerate');
    await click('Continue');
    expect(fake.requests).to.have.length(2);
    expect(output().value).to.equal('');
    expect(output().readOnly).to.equal(true);
    await act(async () => fake.requests[0].emit(completion('Stale response.')));
    expect(output().value).to.equal('');
    await finish('Replacement draft.');
    expect(output().value).to.equal('Replacement draft.');
    await click('Regenerate');
    expect(fake.requests).to.have.length(3);
    expect(document.querySelectorAll('[role="dialog"]')).to.have.length(1);
  });

  it('shows measured phases without inserting progress or enabling edits during generation', async () => {
    await render();
    await click('Generate');
    expect(document.querySelector('[role="status"]')?.textContent).to.contain(
      'Waiting for response',
    );
    expect(document.querySelector('progress')).to.equal(null);
    await act(async () =>
      fake.requests[0].emit({
        kind: 'progress',
        progress: {
          phase: 'loading_model',
          percent: 100,
          outputTokens: null,
          tokensPerSecond: null,
        },
      }),
    );
    expect(document.querySelector('[role="status"]')?.textContent).to.contain('Loading model');
    expect(document.querySelector('[role="status"]')?.textContent).not.to.contain('%');
    expect(document.querySelector('progress')).to.equal(null);
    await act(async () =>
      fake.requests[0].emit({
        kind: 'progress',
        progress: {
          phase: 'prefill',
          percent: 37.5,
          outputTokens: null,
          tokensPerSecond: null,
        },
      }),
    );
    expect(document.querySelector('[role="status"]')?.textContent).to.contain('prefill)… 37%');
    expect(document.querySelector('progress')?.value).to.equal(37.5);
    expect(output().value).to.equal('');
    expect(output().readOnly).to.equal(true);
    expect(button('Replace selection').disabled).to.equal(true);
    await act(async () =>
      fake.requests[0].emit({
        kind: 'progress',
        progress: {
          phase: 'reasoning',
          percent: null,
          outputTokens: 42,
          tokensPerSecond: 12.3,
        },
      }),
    );
    expect(document.querySelector('[role="status"]')?.textContent).to.contain('Thinking');
    expect(document.querySelector('progress')).to.equal(null);
    expect(document.querySelector('.db-ai-generation-status')?.textContent).to.contain(
      '42 tokens generated · 12.3 tokens/s',
    );
    await act(async () => fake.requests[0].emit({ kind: 'delta', text: 'Draft.' }));
    expect(document.querySelector('[role="status"]')?.textContent).to.contain('Writing');
    expect(output().value).to.equal('Draft.');
    await finish('Draft.');
    expect(document.querySelector('.db-ai-generation-status')).to.equal(null);
    expect(output().readOnly).to.equal(false);
    await click('Regenerate');
    await act(async () =>
      fake.requests[0].emit({
        kind: 'progress',
        progress: {
          phase: 'prefill',
          percent: 99,
          outputTokens: null,
          tokensPerSecond: null,
        },
      }),
    );
    expect(document.querySelector('[role="status"]')?.textContent).to.contain(
      'Waiting for response',
    );
    expect(document.querySelector('progress')).to.equal(null);
    await act(async () => fake.requests[1].emit({ kind: 'delta', text: 'New.' }));
    expect(document.querySelector('.db-ai-generation-status')?.textContent).to.contain(
      '4 characters received',
    );
    expect(document.querySelector('.db-ai-generation-status')?.textContent).not.to.contain(
      'tokens',
    );
  });

  it('regenerates without confirmation when edits have been reverted to the generated draft', async () => {
    await render();
    await click('Generate');
    await finish('```markdown\nOriginal draft.\n```');
    expect(output().value).to.equal('Original draft.');
    await type(output(), 'A change.');
    await type(output(), 'Original draft.');
    await click('Regenerate');
    expect(fake.requests).to.have.length(2);
    expect(document.querySelectorAll('[role="dialog"]')).to.have.length(1);
  });

  it('keeps an emptied draft editable and protects that edit from regeneration', async () => {
    await render();
    await click('Generate');
    await finish();
    await type(output(), '');
    expect(output().readOnly).to.equal(false);
    expect(button('Replace selection').disabled).to.equal(true);
    await click('Regenerate');
    expect(fake.requests).to.have.length(1);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    });
    expect(closed).to.equal(0);
    expect(document.querySelectorAll('[role="dialog"]')).to.have.length(1);
    expect(output().value).to.equal('');
  });

  for (const terminal of ['cancelled', 'error'] as const) {
    it(`makes the partial response editable after ${terminal} and protects subsequent edits`, async () => {
      await render();
      await click('Generate');
      await act(async () => fake.requests[0].emit({ kind: 'delta', text: 'Partial response.' }));
      expect(output().readOnly).to.equal(true);
      expect(button('Replace selection').disabled).to.equal(true);
      if (terminal === 'cancelled') {
        await click('Stop');
        expect(fake.requests[0].cancelled).to.equal(true);
      }
      await act(async () =>
        fake.requests[0].emit(
          terminal === 'cancelled'
            ? completion('Partial response.', 'cancelled')
            : { kind: 'error', error: { code: 'timeout', message: 'Request timed out.' } },
        ),
      );
      expect(output().value).to.equal('Partial response.');
      expect(output().readOnly).to.equal(false);
      await type(output(), 'Recovered response.');
      await click('Regenerate');
      expect(fake.requests).to.have.length(1);
      expect(document.body.textContent).to.contain(
        'This will remove all edits you have made. Continue?',
      );
    });
  }

  it('does not start a new request if closed while confirming regeneration', async () => {
    await render();
    await click('Generate');
    await finish();
    await type(output(), 'Unsaved changes.');
    await click('Regenerate');
    await act(async () => root.render(null));
    expect(fake.requests).to.have.length(1);
    expect(fake.requests[0].cancelled).to.equal(true);
    expect(document.querySelector('[role="dialog"]')).to.equal(null);
  });
});
