/**
 * DocBlocks lends its AI to Squisq's Custom summary designer through
 * `createPresentationAssistant`. The designer itself — its slides, layouts,
 * wording and saving — is Squisq's, and tested there; this covers only what
 * DocBlocks adds: readiness from the host's AI status, the model calls, and
 * stopping them.
 */
import { expect } from 'chai';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { createPresentationPlan, defaultPresentationHints } from '@bendyline/squisq/transform';
import type {
  AiChatCompletion,
  AiChatRequest,
  AiResult,
  AiStatus,
  DocBlocksHostAiAPI,
} from '@bendyline/docblocks/host';

import { createPresentationAssistant } from '../src/Presentation/presentation-assistant.js';

const DECK = [
  '# Launch plan',
  '',
  'We ship the editor in March. Two teams share the work.',
  '',
  '## What ships',
  '',
  'The editor, the exporter and the slide designer ship together.',
  '',
  '## Who does what',
  '',
  'Design owns the look. Engineering owns the exporter. Support owns the guide.',
  '',
  '## What happens next',
  '',
  'A beta opens in February. Feedback closes two weeks later.',
].join('\n');

const READY: AiStatus = {
  kind: 'ready',
  provider: { name: 'Test provider', version: null, mode: 'hosted' },
  model: { id: 'm', label: 'Test model', local: true, contextWindow: 8192, isDefault: true },
  activeRequests: 0,
};

/** A host AI whose status the test sets, and whose requests stay open until cancelled. */
function testAi(initial: AiStatus) {
  let status = initial;
  const listeners = new Set<(status: AiStatus) => void>();
  const requests: AiChatRequest[] = [];
  const unused = (): never => {
    throw new Error('Not used by the slide designer');
  };
  const api: DocBlocksHostAiAPI = {
    providerInstalled: unused,
    status: async () => status,
    onStatus: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getPreferences: unused,
    setPreferences: unused,
    connect: unused,
    disconnect: unused,
    models: unused,
    chat(request) {
      requests.push(request);
      let cancel: () => void = () => undefined;
      const done = new Promise<AiResult<AiChatCompletion>>((resolve) => {
        cancel = () => resolve({ ok: false, error: { code: 'cancelled', message: 'Cancelled.' } });
      });
      return { done, cancel };
    },
  };
  return {
    api,
    requests,
    listeners,
    setStatus(next: AiStatus) {
      status = next;
      for (const listener of listeners) listener(next);
    },
  };
}

describe('createPresentationAssistant', () => {
  it('is ready when the host has a model, and says why not otherwise', async () => {
    const ai = testAi(READY);
    const assistant = createPresentationAssistant(ai.api);
    expect(await assistant.readiness()).to.equal(null);

    ai.setStatus({ kind: 'unavailable', reason: 'opt-out' });
    expect(await assistant.readiness()).to.equal('Turn on AI features in Settings.');
    ai.setStatus({ ...READY, model: null });
    expect(await assistant.readiness()).to.equal('Add a model in Settings to use AI.');
  });

  it('tells the designer when readiness may have changed, until it stops listening', () => {
    const ai = testAi(READY);
    const assistant = createPresentationAssistant(ai.api);
    let calls = 0;
    const stop = assistant.onReadinessChange!(() => calls++);
    ai.setStatus({ kind: 'unavailable', reason: 'disconnected' });
    expect(calls).to.equal(1);
    stop();
    ai.setStatus(READY);
    expect(calls).to.equal(1);
    expect(ai.listeners.size).to.equal(0);
  });

  it('asks the model about the plan, and stops when the designer stops it', async () => {
    const ai = testAi(READY);
    const assistant = createPresentationAssistant(ai.api);
    const plan = createPresentationPlan(
      markdownToDoc(parseMarkdown(DECK)),
      defaultPresentationHints(),
    );
    const stop = new AbortController();
    const run = assistant.suggestSlides(plan, {
      signal: stop.signal,
      onProgress: () => undefined,
      onBeat: () => undefined,
    });
    // The model calls load on first use; wait for the first request to go out.
    for (let tries = 0; tries < 50 && ai.requests.length === 0; tries++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ai.requests).to.have.length(1);
    stop.abort();
    const failure = await run.then(
      () => null,
      (cause: unknown) => cause,
    );
    expect((failure as Error | null)?.name).to.equal('AbortError');
  });
});
