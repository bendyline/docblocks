import { expect } from 'chai';
import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  AiChatCompletion,
  AiResult,
  AiStatus,
  DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';
import { NarrationRewriteAction } from '../src/Speech/NarrationRewriteAction.js';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const READY: AiStatus = {
  kind: 'ready',
  provider: { name: 'Test', version: null, mode: 'hosted' },
  model: { id: 'test', label: 'Test', local: true, contextWindow: 4096, isDefault: true },
  activeRequests: 0,
};
function unused(): never {
  throw new Error('Unexpected operation');
}
function fakeAi(status: AiStatus) {
  let count = 0;
  let cancelled = false;
  let resolve!: (result: AiResult<AiChatCompletion>) => void;
  const api: DocBlocksHostAiAPI = {
    providerInstalled: unused,
    status: async () => status,
    onStatus: () => () => undefined,
    getPreferences: unused,
    setPreferences: unused,
    connect: unused,
    disconnect: unused,
    models: unused,
    chat: () => {
      count++;
      return {
        done: new Promise((done) => {
          resolve = done;
        }),
        cancel: () => {
          cancelled = true;
        },
      };
    },
  };
  return {
    api,
    calls: () => count,
    cancelled: () => cancelled,
    complete: (text: string) =>
      resolve({ ok: true, value: { text, model: 'test', finishReason: 'stop', usage: null } }),
  };
}

describe('narration rewrite action', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const button = () => container.querySelector('button')!;

  it('does nothing on open and requires enabled, ready AI', async () => {
    const fake = fakeAi({ kind: 'unavailable', reason: 'opt-out' });
    await act(async () =>
      root.render(
        createElement(NarrationRewriteAction, {
          ai: fake.api,
          text: 'Um, hello.',
          disabled: false,
          onRewrite: unused,
          onBusy: unused,
        }),
      ),
    );
    expect(button().disabled).to.equal(true);
    expect(container.textContent).to.contain('Turn on AI');
    expect(fake.calls()).to.equal(0);
  });

  it('only replaces the draft when a requested rewrite has completed', async () => {
    const fake = fakeAi(READY);
    const changes: string[] = [];
    const busy: boolean[] = [];
    await act(async () =>
      root.render(
        createElement(NarrationRewriteAction, {
          ai: fake.api,
          text: 'Um, hello.',
          disabled: false,
          onRewrite: (text) => changes.push(text),
          onBusy: (value) => busy.push(value),
        }),
      ),
    );
    expect(fake.calls()).to.equal(0);
    await act(async () => button().click());
    expect(fake.calls()).to.equal(1);
    expect(changes).to.deep.equal([]);
    expect(button().textContent).to.equal('Stop rewriting');
    await act(async () => fake.complete('Hello.'));
    expect(changes).to.deep.equal(['Hello.']);
    expect(busy).to.deep.equal([true, false]);
  });

  it('cancels on dialog unmount and ignores late output', async () => {
    const fake = fakeAi(READY);
    const changes: string[] = [];
    await act(async () =>
      root.render(
        createElement(NarrationRewriteAction, {
          ai: fake.api,
          text: 'Um, hello.',
          disabled: false,
          onRewrite: (text) => changes.push(text),
          onBusy: () => undefined,
        }),
      ),
    );
    await act(async () => button().click());
    await act(async () => root.render(null));
    expect(fake.cancelled()).to.equal(true);
    await act(async () => fake.complete('Late response.'));
    expect(changes).to.deep.equal([]);
  });
});
