import { expect } from 'chai';
import type { GezelApp } from '@bendyline/gezel-app-sdk';
import {
  gezelKnowledgeState,
  updateGezelKnowledge,
  withGezelKnowledge,
} from '../main/ai/gezel-knowledge.js';
import { toAiError } from '../main/ai/ai-errors.js';

const messages = [{ role: 'user' as const, content: 'Write about science.' }];
const passage = {
  uri: 'knowledge://publisher/science/article',
  title: 'Science',
  catalogId: 'science',
  version: '1',
  text: 'A cited fact.',
};
function app(
  retrieve: (
    request: Record<string, unknown>,
    options: { signal: AbortSignal },
  ) => Promise<unknown>,
): GezelApp {
  return {
    knowledge: { retrieve, state: async () => ({}), update: async () => undefined },
  } as unknown as GezelApp;
}
async function rejects(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return toAiError(error);
  }
  throw new Error('Expected retrieval to fail');
}
describe('Gezel knowledge in inference', () => {
  it('leaves ranking to the SDK, forwards cancellation, and cites untrusted passages', async () => {
    const signal = new AbortController().signal;
    let observed: unknown;
    const result = await withGezelKnowledge(
      app(async (request, options) => {
        observed = request;
        expect(options.signal).to.equal(signal);
        return { reranked: true, passages: [passage] };
      }),
      messages,
      signal,
    );
    expect(observed).to.include({ query: 'Write about science.', maxResults: 4 });
    expect(observed).not.to.have.property('rerank');
    expect(result[0].content)
      .to.contain('untrusted source material')
      .and.contain(passage.uri)
      .and.contain(passage.text);
    expect(result.slice(1)).to.deep.equal(messages);
  });
  it('keeps the prompt when no relevant knowledge is found', async () => {
    expect(
      await withGezelKnowledge(
        app(async () => ({ reranked: true, passages: [] })),
        messages,
        new AbortController().signal,
      ),
    ).to.deep.equal(messages);
  });
  it('sends the request without knowledge whenever retrieval fails', async () => {
    for (const code of ['knowledge_unavailable', 'unauthorized', 'rate_limited']) {
      expect(
        await withGezelKnowledge(
          app(async () => {
            throw Object.assign(new Error('unavailable'), { code });
          }),
          messages,
          new AbortController().signal,
        ),
      ).to.deep.equal(messages);
    }
    expect(
      await withGezelKnowledge({} as GezelApp, messages, new AbortController().signal),
    ).to.deep.equal(messages);
  });
  it('skips retrieval when the context window leaves no room', async () => {
    let called = false;
    const long = [{ role: 'user' as const, content: 'x'.repeat(12_000) }];
    expect(
      await withGezelKnowledge(
        app(async () => {
          called = true;
          return { reranked: true, passages: [] };
        }),
        long,
        new AbortController().signal,
        4096,
      ),
    ).to.deep.equal(long);
    expect(called).to.equal(false);
  });
  it('injects passages Gezel admitted without ranking', async () => {
    const result = await withGezelKnowledge(
      app(async () => ({ reranked: false, passages: [passage] })),
      messages,
      new AbortController().signal,
    );
    expect(result[0].content).to.contain(passage.text);
  });
  it('never injects any part of a malformed answer', async () => {
    for (const raw of [
      { reranked: 'yes', passages: [passage] },
      { reranked: true, passages: [passage, { ...passage, text: 'x'.repeat(12_001) }] },
      { reranked: true, passages: [passage], extra: true },
    ]) {
      expect(
        await withGezelKnowledge(
          app(async () => raw),
          messages,
          new AbortController().signal,
        ),
      ).to.deep.equal(messages);
    }
  });
  it('does not include late retrieval after cancellation', async () => {
    const controller = new AbortController();
    const result = withGezelKnowledge(
      app(async () => {
        controller.abort();
        return { reranked: true, passages: [passage] };
      }),
      messages,
      controller.signal,
    );
    expect((await rejects(result)).code).to.equal('cancelled');
  });
  it('drops evidence that serializes past the selected model context budget', async () => {
    const result = await withGezelKnowledge(
      app(async (request) => ({
        reranked: true,
        passages: [{ ...passage, text: '\\'.repeat(request.maxCharacters as number) }],
      })),
      messages,
      new AbortController().signal,
      4096,
    );
    expect(result).to.deep.equal(messages);
  });
});

describe('Gezel knowledge catalogs', () => {
  const catalogs = [{ id: 'science' }];
  function stateApp(state: unknown, actions: unknown[] = []): GezelApp {
    return {
      knowledge: {
        state: async () => state,
        update: async (action: unknown) => {
          actions.push(action);
        },
        retrieve: async () => ({ reranked: true, passages: [] }),
      },
    } as unknown as GezelApp;
  }
  it("passes on the SDK's improvement offer and nothing about the model behind it", async () => {
    const signal = new AbortController().signal;
    expect(
      await gezelKnowledgeState(
        stateApp({
          catalogs,
          reranker: { ready: false, downloading: false, message: 'Download the relevance model.' },
          improvement: { downloadBytes: 23_856_961, downloading: false, percent: null },
        }),
        signal,
      ),
    ).to.deep.equal({
      catalogs,
      improvement: { downloadBytes: 23_856_961, downloading: false },
    });
    // An SDK that predates the offer has nothing to offer.
    expect(
      await gezelKnowledgeState(
        stateApp({ catalogs, reranker: { ready: false, downloading: false, message: null } }),
        signal,
      ),
    ).to.deep.equal({ catalogs, improvement: null });
  });
  it('starts the improvement download through the SDK', async () => {
    const actions: unknown[] = [];
    const app = stateApp({}, actions);
    await updateGezelKnowledge(app, { action: 'improve' }, new AbortController().signal);
    await updateGezelKnowledge(
      app,
      { action: 'enable', catalogId: 'science' },
      new AbortController().signal,
    );
    expect(actions).to.deep.equal([
      { action: 'prepare-reranker' },
      { action: 'enable', catalogId: 'science' },
    ]);
  });
});
