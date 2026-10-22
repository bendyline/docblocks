import { expect } from 'chai';
import * as React from 'react';
import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  EditorProvider,
  useEditorContext,
  type EditorContextValue,
} from '@bendyline/squisq-editor-react';
import type {
  AiChatCompletion,
  AiChatRequest,
  AiResult,
  AiStatus,
  DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';

import { AiIllustratePanel } from '../src/Ai/AiDiagrams.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

const SOURCE = `# Launch

## Rollout

The rollout happens in stages. First the team drafts the plan, then a manager reviews it, and next the
launch is announced. Finally the team measures adoption and repeats the review.

## History

The company was founded in 2019, shipped its first product in 2021, and opened a Berlin office in 2023.
`;

const PLAN =
  '[{"passage":"P1","kind":"flow","title":"Rollout flow","show":"How the plan moves from draft to launch."},' +
  '{"passage":"P2","kind":"timeline","title":"Milestones","show":"The company milestones by year."}]';
const FLOW =
  '{"direction":"LR","nodes":[{"id":"a","label":"Team drafts plan"},{"id":"b","label":"Manager reviews"},' +
  '{"id":"c","label":"Launch announced"}],"edges":[{"from":"a","to":"b"},{"from":"b","to":"c"}]}';
const TIMELINE =
  '{"events":[{"when":"2019","label":"Company founded"},{"when":"2021","label":"First product"},' +
  '{"when":"2023","label":"Berlin office"}]}';
/** Has a year only the person's own prompt states. */
const TIMELINE_WITH_TOKYO =
  '{"events":[{"when":"2019","label":"Company founded"},{"when":"2023","label":"Berlin office"},' +
  '{"when":"2025","label":"Tokyo office"}]}';

const READY: AiStatus = {
  kind: 'ready',
  provider: { mode: 'hosted' } as Extract<AiStatus, { kind: 'ready' }>['provider'],
  model: { id: 'm', label: 'Model', local: true, contextWindow: 4_096, isDefault: true },
  activeRequests: 0,
};

function unused(): never {
  throw new Error('Not used by the illustrate panel');
}

function scriptedAi(plan: string, timeline = TIMELINE) {
  const requests: AiChatRequest[] = [];
  const api: DocBlocksHostAiAPI = {
    providerInstalled: unused,
    status: () => Promise.resolve(READY),
    onStatus: () => () => undefined,
    getPreferences: unused,
    setPreferences: unused,
    connect: unused,
    disconnect: unused,
    models: unused,
    chat(request) {
      requests.push(request);
      const system = request.messages[0]?.content ?? '';
      const text = system.startsWith('You plan illustrations')
        ? plan
        : system.includes('flowchart')
          ? FLOW
          : timeline;
      const done = new Promise<AiResult<AiChatCompletion>>((resolve) =>
        setTimeout(
          () =>
            resolve({ ok: true, value: { text, finishReason: 'stop', model: 'm', usage: null } }),
          1,
        ),
      );
      return { done, cancel: () => undefined };
    },
  };
  return { api, requests };
}

/** A Monaco double over SOURCE that records undo stops and edits. */
function fakeMonaco(calls: string[], edits: unknown[][]) {
  const positionAt = (offset: number) => {
    const lines = SOURCE.slice(0, offset).split('\n');
    return { lineNumber: lines.length, column: (lines[lines.length - 1] ?? '').length + 1 };
  };
  return {
    getModel: () => ({ getValue: () => SOURCE, getPositionAt: positionAt }),
    getSelection: () => null,
    pushUndoStop: () => calls.push('undoStop'),
    executeEdits: (_source: string, ops: unknown[]) => {
      calls.push('edit');
      edits.push(ops);
      return true;
    },
  } as unknown as Parameters<EditorContextValue['setMonacoEditor']>[0];
}

async function waitFor(check: () => boolean, label: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`Timed out waiting for ${label}: ${document.body.textContent ?? ''}`);
}

/** Render the panel over SOURCE in Source view, with edits recorded. */
async function renderPanel(ai: DocBlocksHostAiAPI) {
  const calls: string[] = [];
  const edits: unknown[][] = [];
  let editor: EditorContextValue | null = null;
  function SourceView() {
    editor = useEditorContext();
    return null;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(EditorProvider, {
          initialMarkdown: SOURCE,
          children: [
            createElement(SourceView, { key: 'probe' }),
            createElement(AiIllustratePanel, { key: 'panel', ai, onClose: () => undefined }),
          ],
        }),
      ),
    );
  });
  await act(async () => {
    editor?.setActiveView('raw');
    editor?.setMonacoEditor(fakeMonaco(calls, edits));
  });
  const button = (label: string) => {
    const found = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (!found) throw new Error(`No "${label}" button in: ${container.textContent ?? ''}`);
    return found;
  };
  const click = async (label: string) => {
    const target = button(label);
    await act(async () => target.click());
  };
  return {
    container,
    calls,
    edits,
    button,
    click,
    cards: () => Array.from(container.querySelectorAll<HTMLElement>('.db-ai-idea-card')),
    previews: () => container.querySelectorAll('.db-ai-diagram-preview[role="img"]'),
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

/** Type into a controlled field, or choose an option, as a person would. */
async function setField(
  field: HTMLTextAreaElement | HTMLInputElement | HTMLSelectElement,
  value: string,
) {
  await act(async () => {
    if (field instanceof HTMLSelectElement) {
      field.value = value;
      field.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    const prototype =
      field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('AiIllustratePanel', () => {
  it('finds ideas on open, draws nothing until asked, then inserts them as one undoable edit', async () => {
    const { api, requests } = scriptedAi(PLAN);
    const panel = await renderPanel(api);

    await waitFor(() => panel.cards().length === 2, 'two ideas');
    // Phase one is one planning call; nothing is drawn yet.
    expect(requests).to.have.length(1);
    expect(panel.previews()).to.have.length(0);
    const prompts = panel.cards().map((card) => card.querySelector('textarea')?.value);
    expect(prompts).to.deep.equal([
      'How the plan moves from draft to launch.',
      'The company milestones by year.',
    ]);

    await panel.click('Draw 2 pictures');
    await waitFor(
      () => /Insert all \(2\)/u.test(panel.container.textContent ?? ''),
      'two ready pictures',
    );
    expect(panel.container.querySelector('[aria-current="step"]')?.textContent?.trim()).to.contain(
      'Pictures',
    );
    // One plan call and one call per idea, all marked as illustration work.
    expect(requests.map((request) => request.purpose)).to.deep.equal([
      'illustrate',
      'illustrate',
      'illustrate',
    ]);
    // Each idea's prompt is what phase two is asked to draw.
    expect(requests[1]?.messages[1]?.content).to.contain(
      'Draw this: How the plan moves from draft to launch.',
    );
    expect(panel.previews()).to.have.length(2);
    expect(panel.previews()[0]?.getAttribute('aria-label')).to.contain('Rollout flow');

    await panel.click('Insert all (2)');
    expect(panel.calls).to.deep.equal(['undoStop', 'edit', 'undoStop']);
    expect(panel.edits[0]).to.have.length(2);
    expect(panel.container.textContent).to.contain('Inserted.');

    await panel.cleanup();
  });

  it('lets the person write their own idea when none are found, and draws from it', async () => {
    const { api, requests } = scriptedAi('[]', TIMELINE_WITH_TOKYO);
    const panel = await renderPanel(api);

    await waitFor(
      () => /No passage here stood out/u.test(panel.container.textContent ?? ''),
      'no ideas found',
    );
    expect(panel.button('Draw pictures').disabled).to.equal(true);

    await panel.click('Add idea');
    const [card] = panel.cards();
    const textarea = card?.querySelector('textarea');
    const [kind, placement] = Array.from(card?.querySelectorAll('select') ?? []);
    if (!card || !textarea || !kind || !placement) throw new Error('The idea has no fields.');
    expect(document.activeElement).to.equal(textarea);

    await setField(textarea, 'The milestones by year, ending with the Tokyo office in 2025.');
    await setField(kind, 'timeline');
    const history = Array.from(placement.options).find((option) =>
      option.textContent?.startsWith('History:'),
    );
    await setField(placement, history?.value ?? '');

    await panel.click('Draw 1 picture');
    await waitFor(() => panel.previews().length === 1, 'the drawn idea');
    // The person's own words count as facts, so 2025 passes the grounding check.
    expect(requests).to.have.length(2);
    expect(requests[1]?.messages[0]?.content).to.contain('or after "Draw this"');
    expect(requests[1]?.messages[1]?.content).to.contain('The company was founded in 2019');

    // Changing the idea after drawing it asks for a redraw before inserting.
    await panel.click('Edit idea');
    const title = panel.cards()[0]?.querySelector('input');
    if (!title) throw new Error('The idea has no title field.');
    await setField(title, 'Company history');
    expect(panel.button('Draw 1 picture').disabled).to.equal(false);
    const pictures = panel.container.querySelector<HTMLButtonElement>(
      '.db-ai-illustrate-steps li:last-child button',
    );
    await act(async () => pictures?.click());
    expect(panel.container.textContent).to.contain('You changed this idea after it was drawn.');
    expect(
      Array.from(panel.container.querySelectorAll('button')).some(
        (candidate) => candidate.textContent === 'Insert',
      ),
    ).to.equal(false);

    await panel.cleanup();
  });
});
