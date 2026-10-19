import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { BlockInsertionBuilder, EditorSelectionInfo } from '@bendyline/squisq-editor-react';
import type {
  AiChatCompletion,
  AiChatRequest,
  AiResult,
  AiStatus,
  DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';

import { AiDiagramDialog } from '../src/Ai/AiDiagrams.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

const PICTURE =
  '<svg viewBox="0 0 640 200"><title>Water cycle</title>' +
  '<circle cx="100" cy="100" r="60" fill="currentColor" fill-opacity="0.1" stroke="currentColor"/>' +
  '<text x="100" y="105" text-anchor="middle" font-family="sans-serif">Rain</text></svg>';

function status(contextWindow: number): AiStatus {
  return {
    kind: 'ready',
    provider: { mode: 'hosted' } as Extract<AiStatus, { kind: 'ready' }>['provider'],
    model: { id: 'm', label: 'Model', local: true, contextWindow, isDefault: true },
    activeRequests: 0,
  };
}

function unused(): never {
  throw new Error('Not used by the diagram dialog');
}

function scriptedAi(contextWindow: number) {
  const requests: AiChatRequest[] = [];
  const api: DocBlocksHostAiAPI = {
    providerInstalled: unused,
    status: () => Promise.resolve(status(contextWindow)),
    onStatus: () => () => undefined,
    getPreferences: unused,
    setPreferences: unused,
    connect: unused,
    disconnect: unused,
    models: unused,
    chat(request) {
      requests.push(request);
      const done = Promise.resolve<AiResult<AiChatCompletion>>({
        ok: true,
        value: { text: PICTURE, finishReason: 'stop', model: 'm', usage: null },
      });
      return { done, cancel: () => undefined };
    },
  };
  return { api, requests };
}

const CURSOR: EditorSelectionInfo = { view: 'wysiwyg', text: '', empty: true };

async function waitFor(check: () => boolean, label: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`Timed out waiting for ${label}: ${document.body.textContent ?? ''}`);
}

async function renderDialog(contextWindow: number) {
  const ai = scriptedAi(contextWindow);
  const inserted: string[] = [];
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(AiDiagramDialog, {
        ai: ai.api,
        documentSource: '# Notes\n\nSome text.\n',
        capturedSelection: CURSOR,
        getSelection: () => CURSOR,
        insertBlockAfterCursor: (block: string | BlockInsertionBuilder) => {
          // A fence goes after the cursor's block whatever the context.
          const markdown =
            typeof block === 'string' ? block : block({} as Parameters<BlockInsertionBuilder>[0]);
          if (markdown !== null) inserted.push(markdown);
          return markdown !== null;
        },
        onClose: () => undefined,
      }),
    );
  });
  const select = () =>
    document.body.querySelector<HTMLSelectElement>('.db-ai-diagram-dialog select');
  await waitFor(() => select() !== null, 'the kind menu');
  // Let the status promise settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  const options = () => Array.from(select()?.options ?? []).map((option) => option.value);
  const cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return { ai, inserted, select, options, cleanup };
}

describe('AiDiagramDialog', () => {
  it('offers the SVG diagram kinds to every model, and Illustration only to large ones', async () => {
    const small = await renderDialog(4_096);
    expect(small.options()).to.include.members(['venn', 'matrix', 'funnel', 'pyramid']);
    expect(small.options()).not.to.include('illustration');
    await small.cleanup();

    const large = await renderDialog(32_768);
    expect(large.options()).to.include('illustration');
    await large.cleanup();
  });

  it('draws an illustration and inserts it as an SVG picture', async () => {
    const dialog = await renderDialog(32_768);
    const textarea = document.body.querySelector<HTMLTextAreaElement>(
      '.db-ai-diagram-dialog textarea',
    );
    await act(async () => {
      const select = dialog.select();
      if (!select || !textarea) throw new Error('Dialog controls are missing.');
      select.value = 'illustration';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setValue?.call(textarea, 'The water cycle');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(document.body.textContent).to.contain('The model draws this picture itself');
    const button = (label: string) =>
      Array.from(document.body.querySelectorAll('button')).find(
        (candidate) => candidate.textContent === label,
      );
    await act(async () => button('Generate')?.click());
    await waitFor(() => button('Insert')?.disabled === false, 'a ready illustration');
    expect(dialog.ai.requests).to.have.length(1);
    expect(dialog.ai.requests[0]?.messages[0]?.content).to.contain('standalone SVG');
    expect(document.body.textContent).to.contain('Check the picture against your text');
    await act(async () => button('Insert')?.click());
    expect(dialog.inserted).to.deep.equal([`\`\`\`svg\n${PICTURE}\n\`\`\``]);
    await dialog.cleanup();
  });
});
