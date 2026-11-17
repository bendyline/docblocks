import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorContextMenuProvider, EditorProvider } from '@bendyline/squisq-editor-react';
import type { AiModelInfo, AiStatus, DocBlocksHostAiAPI } from '@bendyline/docblocks/host';

import { AiToolbarControl } from '../src/Ai/AiEditorAssistant.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

const MODEL: AiModelInfo = {
  id: 'm',
  label: 'Model',
  local: true,
  contextWindow: 32_768,
  isDefault: true,
};

function ready(model: AiModelInfo | null): AiStatus {
  return {
    kind: 'ready',
    provider: { mode: 'hosted' } as Extract<AiStatus, { kind: 'ready' }>['provider'],
    model,
    activeRequests: 0,
  };
}

function unused(): never {
  throw new Error('Not used by the AI actions menu');
}

/** A host whose answer to `status()` the test changes, and which counts the questions. */
function hostAnswering(initial: AiStatus) {
  const state = { answer: initial, asked: 0 };
  const api: DocBlocksHostAiAPI = {
    providerInstalled: unused,
    status: () => {
      state.asked += 1;
      return Promise.resolve(state.answer);
    },
    onStatus: () => () => undefined,
    getPreferences: unused,
    setPreferences: unused,
    connect: unused,
    disconnect: unused,
    models: unused,
    chat: unused,
  };
  return { api, state };
}

async function waitFor(check: () => boolean, label: string) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`Timed out waiting for ${label}: ${document.body.textContent ?? ''}`);
}

function item(label: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
}

const trigger = () => document.body.querySelector<HTMLButtonElement>('[aria-label="AI actions"]');
const menu = () => document.body.querySelector<HTMLElement>('[role="menu"]');

const mounted: { root: Root; host: HTMLElement }[] = [];

afterEach(async () => {
  for (const { root, host } of mounted.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
});

async function renderMenu(ai: DocBlocksHostAiAPI, onOpenSettings?: () => void) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () =>
    root.render(
      createElement(EditorProvider, {
        initialMarkdown: '# Notes\n',
        fileName: 'notes.md',
        children: createElement(EditorContextMenuProvider, {
          rootRef: { current: host },
          children: createElement(AiToolbarControl, {
            ai,
            openPanel: null,
            onOpenPanel: () => undefined,
            onOpenSettings,
          }),
        }),
      }),
    ),
  );
  await waitFor(() => trigger() !== null, 'the AI actions button');
}

async function openMenu() {
  await act(async () => trigger()?.click());
  await waitFor(() => menu() !== null, 'the AI actions menu');
}

describe('AI actions menu status', () => {
  it('asks the host again on opening, so a stale "no model" answer does not stick', async () => {
    const { api, state } = hostAnswering(ready(null));
    await renderMenu(api);
    await waitFor(() => state.asked === 1, 'the first status question');

    // The model the host could not see at launch is ready by the time the menu opens.
    state.answer = ready(MODEL);
    await openMenu();
    await waitFor(() => state.asked === 2, 'the menu asking again');
    await waitFor(
      () => !menu()?.textContent?.includes('Add a model'),
      'the no-model note to clear',
    );
    expect(menu()?.querySelector('[role="status"]')).to.equal(null);
    expect(item('Add a model in Settings to use AI.')).to.equal(undefined);
  });

  it('opens Settings from the no-model note', async () => {
    const { api } = hostAnswering(ready(null));
    let opened = 0;
    await renderMenu(api, () => {
      opened += 1;
    });
    await openMenu();
    const note = 'Add a model in Settings to use AI.';
    await waitFor(() => item(note) !== undefined, 'the no-model note');
    expect(item(note)?.getAttribute('role')).to.equal('menuitem');
    await act(async () => item(note)?.click());
    expect(opened).to.equal(1);
    expect(menu()).to.equal(null);
  });

  it('keeps other statuses as plain notes', async () => {
    const { api } = hostAnswering({
      kind: 'connecting',
      step: 'preparing-model',
      verificationCode: null,
      progress: null,
    });
    await renderMenu(api, () => undefined);
    await openMenu();
    await waitFor(
      () => menu()?.querySelector('[role="status"]')?.textContent === 'AI is getting ready…',
      'the getting-ready note',
    );
    expect(item('AI is getting ready…')).to.equal(undefined);
  });
});
