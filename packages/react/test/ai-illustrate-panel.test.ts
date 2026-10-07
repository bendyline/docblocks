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
  '[{"passage":"P1","kind":"flow","title":"Rollout flow"},{"passage":"P2","kind":"timeline","title":"Milestones"}]';
const FLOW =
  '{"direction":"LR","nodes":[{"id":"a","label":"Team drafts plan"},{"id":"b","label":"Manager reviews"},' +
  '{"id":"c","label":"Launch announced"}],"edges":[{"from":"a","to":"b"},{"from":"b","to":"c"}]}';
const TIMELINE =
  '{"events":[{"when":"2019","label":"Company founded"},{"when":"2021","label":"First product"},' +
  '{"when":"2023","label":"Berlin office"}]}';

const READY: AiStatus = {
  kind: 'ready',
  provider: { mode: 'hosted' } as Extract<AiStatus, { kind: 'ready' }>['provider'],
  model: { id: 'm', label: 'Model', local: true, contextWindow: 4_096, isDefault: true },
  activeRequests: 0,
};

function unused(): never {
  throw new Error('Not used by the illustrate panel');
}

function scriptedAi() {
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
        ? PLAN
        : system.includes('flowchart')
          ? FLOW
          : TIMELINE;
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

describe('AiIllustratePanel', () => {
  it('suggests diagrams on open and inserts them all as one undoable edit', async () => {
    const { api, requests } = scriptedAi();
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
              createElement(AiIllustratePanel, { key: 'panel', ai: api, onClose: () => undefined }),
            ],
          }),
        ),
      );
    });
    await act(async () => {
      editor?.setActiveView('raw');
      editor?.setMonacoEditor(fakeMonaco(calls, edits));
    });

    await waitFor(
      () => /Insert all \(2\)/u.test(container.textContent ?? ''),
      'two ready suggestions',
    );
    // One plan call and one call per suggestion, all marked as illustration work.
    expect(requests.map((request) => request.purpose)).to.deep.equal([
      'illustrate',
      'illustrate',
      'illustrate',
    ]);
    const previews = container.querySelectorAll('.db-ai-diagram-preview[role="img"]');
    expect(previews).to.have.length(2);
    expect(previews[0]?.getAttribute('aria-label')).to.contain('Rollout flow');

    const insertAll = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.startsWith('Insert all'),
    );
    await act(async () => insertAll?.click());
    expect(calls).to.deep.equal(['undoStop', 'edit', 'undoStop']);
    expect(edits[0]).to.have.length(2);
    expect(container.textContent).to.contain('Inserted.');

    await act(async () => root.unmount());
    container.remove();
  });
});
