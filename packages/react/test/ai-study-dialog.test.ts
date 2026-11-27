import { expect } from 'chai';
import * as React from 'react';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  EditorContextMenuProvider,
  EditorProvider,
  useEditorContext,
  type EditorContextValue,
} from '@bendyline/squisq-editor-react';
import { MemoryContentContainer, type ContentContainer } from '@bendyline/squisq/storage';
import type {
  AiChatCompletion,
  AiChatRequest,
  AiResult,
  AiStatus,
  DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';

import { AiToolbarControl } from '../src/Ai/AiEditorAssistant.js';
import { AiStudyDialog } from '../src/Ai/AiStudyDialog.js';
import { studyAidPath, studySourceDigest, withStudyAidFrontmatter } from '../src/Ai/study-aids.js';

// The root Mocha/tsx loader does not inherit the package's react-jsx setting.
(globalThis as typeof globalThis & { React: typeof React }).React = React;

const DOCUMENT = [
  '# Plants',
  '',
  'Plants take in carbon dioxide and release oxygen during photosynthesis. Photosynthesis ' +
    'happens in the leaves, inside chloroplasts. Roots take up water from the soil.',
  '',
].join('\n');

const SUMMARY_REPLY = 'Plants turn light into food.\n\n- They take in carbon dioxide.';

type Reply = string | { readonly error: string } | { readonly hang: true };

function status(): AiStatus {
  return {
    kind: 'ready',
    provider: { mode: 'hosted' } as Extract<AiStatus, { kind: 'ready' }>['provider'],
    model: { id: 'm', label: 'Model', local: true, contextWindow: 32_768, isDefault: true },
    activeRequests: 0,
  };
}

function unused(): never {
  throw new Error('Not used by study aids');
}

function scriptedAi(answer: (request: AiChatRequest) => Reply) {
  const requests: AiChatRequest[] = [];
  const api: DocBlocksHostAiAPI = {
    providerInstalled: unused,
    status: () => Promise.resolve(status()),
    onStatus: () => () => undefined,
    getPreferences: unused,
    setPreferences: unused,
    connect: unused,
    disconnect: unused,
    models: unused,
    chat(request) {
      requests.push(request);
      const cancelled: AiResult<AiChatCompletion> = {
        ok: true,
        value: { text: '', finishReason: 'cancelled', model: 'm', usage: null },
      };
      let settle: (result: AiResult<AiChatCompletion>) => void = () => undefined;
      const done = new Promise<AiResult<AiChatCompletion>>((resolve) => {
        settle = resolve;
      });
      const reply = answer(request);
      if (typeof reply === 'string') {
        settle({ ok: true, value: { text: reply, finishReason: 'stop', model: 'm', usage: null } });
      } else if ('error' in reply) {
        settle({ ok: false, error: { code: 'timeout', message: reply.error } });
      }
      return { done, cancel: () => settle(cancelled) };
    },
  };
  return { api, requests };
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

function dialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('.db-ai-study-dialog');
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
}

async function click(label: string) {
  await waitFor(() => button(label) !== undefined, `the ${label} button`);
  await act(async () => button(label)?.click());
}

async function readText(container: ContentContainer, path: string): Promise<string | null> {
  const data = await container.readFile(path);
  return data === null ? null : new TextDecoder().decode(data);
}

async function savedFor(source: string, body: string) {
  return withStudyAidFrontmatter(body, 'Saved', {
    kind: 'summary',
    source: 'plants.md',
    sourceSha256: await studySourceDigest(source),
    generatedAt: '2026-10-01T09:30:00.000Z',
    model: 'Earlier Model',
  });
}

const mounted: { root: Root; host: HTMLElement }[] = [];

async function renderDialog(options: {
  ai: DocBlocksHostAiAPI;
  container: ContentContainer;
  source?: string;
}) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  let closed = false;
  await act(async () => {
    root.render(
      createElement(AiStudyDialog, {
        ai: options.ai,
        kind: 'summary',
        documentSource: options.source ?? DOCUMENT,
        documentName: 'plants.md',
        container: options.container,
        onClose: () => {
          closed = true;
        },
      }),
    );
  });
  await waitFor(() => dialog() !== null, 'the dialog');
  return { isClosed: () => closed };
}

afterEach(async () => {
  for (const { root, host } of mounted.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
});

describe('AiStudyDialog', () => {
  it('offers the saved summary, and shows it without calling the model', async () => {
    const ai = scriptedAi(() => SUMMARY_REPLY);
    const container = new MemoryContentContainer();
    await container.writeFile(
      studyAidPath('summary'),
      new TextEncoder().encode(await savedFor(DOCUMENT, '# Summary\n\nAn earlier summary.')),
    );
    await renderDialog({ ai: ai.api, container });
    await waitFor(() => button('View summary') !== undefined, 'the saved summary');
    expect(dialog()?.textContent).to.contain('Saved summary');
    expect(dialog()?.textContent).to.contain('with Earlier Model');
    // Give the staleness check time to settle: the document is unchanged.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(dialog()?.textContent).not.to.contain('has changed since');
    expect(button('Regenerate summary')).not.to.equal(undefined);

    await click('View summary');
    await waitFor(() => dialog()?.querySelector('.db-ai-study-summary') !== null, 'the viewer');
    expect(dialog()?.textContent).to.contain('An earlier summary.');
    expect(ai.requests).to.have.length(0);
  });

  it('says when the document has changed since the saved study aid was made', async () => {
    const container = new MemoryContentContainer();
    await container.writeFile(
      studyAidPath('summary'),
      new TextEncoder().encode(await savedFor('# Plants\n\nOlder text.', 'Old.')),
    );
    await renderDialog({ ai: scriptedAi(() => '').api, container });
    await waitFor(
      () => dialog()?.textContent?.includes('The document has changed since') === true,
      'the stale note',
    );
  });

  it('keeps the saved file and the viewer when a regenerate fails', async () => {
    const ai = scriptedAi(() => ({ error: 'The model stopped responding.' }));
    const container = new MemoryContentContainer();
    const earlier = await savedFor(DOCUMENT, 'An earlier summary.');
    await container.writeFile(studyAidPath('summary'), new TextEncoder().encode(earlier));
    await renderDialog({ ai: ai.api, container });
    await click('View summary');
    await click('Regenerate summary');
    await waitFor(
      () =>
        dialog()?.querySelector('[role="alert"]')?.textContent === 'The model stopped responding.',
      'the error',
    );
    expect(dialog()?.textContent).to.contain('An earlier summary.');
    expect(await readText(container, studyAidPath('summary'))).to.equal(earlier);
  });

  it('keeps the saved file when a regenerate is stopped', async () => {
    const ai = scriptedAi(() => ({ hang: true }));
    const container = new MemoryContentContainer();
    const earlier = await savedFor(DOCUMENT, 'An earlier summary.');
    await container.writeFile(studyAidPath('summary'), new TextEncoder().encode(earlier));
    await renderDialog({ ai: ai.api, container });
    await click('Regenerate summary');
    await waitFor(
      () => dialog()?.textContent?.includes('Writing the summary') === true,
      'progress',
    );
    await click('Stop');
    await waitFor(() => button('Regenerate summary') !== undefined, 'the start screen');
    expect(dialog()?.querySelector('[role="alert"]')).to.equal(null);
    expect(await readText(container, studyAidPath('summary'))).to.equal(earlier);
  });

  it('shows the result with the reason when it cannot be saved', async () => {
    const ai = scriptedAi(() => SUMMARY_REPLY);
    const container = new MemoryContentContainer();
    container.writeFile = () => Promise.reject(new Error('The disk is full.'));
    await renderDialog({ ai: ai.api, container });
    await click('Generate summary');
    await waitFor(() => dialog()?.querySelector('.db-ai-study-summary') !== null, 'the viewer');
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).to.equal(
      'The summary could not be saved: The disk is full.',
    );
    // Nothing was saved, so there is still nothing to regenerate from disk.
    expect(dialog()?.textContent).to.contain('Plants turn light into food.');
  });
});

describe('AI actions menu study aids', () => {
  type ViewState = Pick<EditorContextValue, 'layoutMode' | 'activeView'>;

  async function renderMenu(container: ContentContainer, ai: DocBlocksHostAiAPI) {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    mounted.push({ root, host });
    const rootRef = { current: host };
    // The editor's view as of its latest render, read from inside the provider.
    let view: ViewState | null = null;
    function ViewProbe() {
      const { layoutMode, activeView } = useEditorContext();
      view = { layoutMode, activeView };
      return null;
    }
    const tree = (workspaceContainer: ContentContainer) =>
      createElement(EditorProvider, {
        initialMarkdown: DOCUMENT,
        workspaceContainer,
        fileName: 'notes/plants.md',
        children: createElement(
          Fragment,
          null,
          createElement(ViewProbe),
          createElement(EditorContextMenuProvider, {
            rootRef,
            children: createElement(AiToolbarControl, {
              ai,
              openPanel: null,
              onOpenPanel: () => undefined,
            }),
          }),
        ),
      });
    await act(async () => root.render(tree(container)));
    return {
      rerender: (next: ContentContainer) => act(async () => root.render(tree(next))),
      view: () => view,
    };
  }

  async function openMenu() {
    const trigger = () =>
      document.body.querySelector<HTMLButtonElement>('[aria-label="AI actions"]');
    await waitFor(() => trigger() !== null, 'the AI actions button');
    await act(async () => trigger()?.click());
  }

  it('opens the summary dialog from Summarize document…, and closes it when the document changes', async () => {
    const ai = scriptedAi(() => SUMMARY_REPLY);
    const first = new MemoryContentContainer();
    const menu = await renderMenu(first, ai.api);
    await openMenu();
    await waitFor(() => button('Summarize document…')?.disabled === false, 'Summarize enabled');
    await click('Summarize document…');
    await waitFor(() => dialog() !== null, 'the summary dialog');
    await click('Generate summary');
    await waitFor(() => dialog()?.querySelector('.db-ai-study-summary') !== null, 'the viewer');
    const saved = await readText(first, studyAidPath('summary'));
    expect(saved).to.contain('docblocks-source: plants.md');

    await menu.rerender(new MemoryContentContainer());
    await waitFor(() => dialog() === null, 'the dialog to close');
  });

  for (const label of ['Create quiz…', 'Create flashcards…']) {
    it(`switches the editor to the Study cards view from ${label}, without calling the model`, async () => {
      const ai = scriptedAi(() => SUMMARY_REPLY);
      const menu = await renderMenu(new MemoryContentContainer(), ai.api);
      expect(menu.view()).to.deep.equal({ layoutMode: 'document', activeView: 'raw' });
      await openMenu();
      await waitFor(() => button(label)?.disabled === false, `${label} enabled`);
      await click(label);
      await waitFor(() => menu.view()?.layoutMode === 'study', 'the Study cards layout');
      expect(menu.view()).to.deep.equal({ layoutMode: 'study', activeView: 'wysiwyg' });
      // Give any stray run time to start: none should, and no dialog opens.
      await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
      expect(ai.requests).to.have.length(0);
      expect(dialog()).to.equal(null);
    });
  }
});
