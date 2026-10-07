import { expect } from 'chai';
import type { GezelApp } from '@bendyline/gezel-app-sdk';
import { withGezelKnowledge } from '../main/ai/gezel-knowledge.js';
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
  it('requires reranking, forwards cancellation, and includes cited untrusted passages', async () => {
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
    expect(observed).to.include({
      query: 'Write about science.',
      rerank: 'required',
      maxResults: 4,
    });
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
    ).to.equal(messages);
  });
  it('never silently falls back to unranked knowledge or an old SDK', async () => {
    for (const raw of [
      { reranked: false, passages: [passage] },
      { reranked: true, passages: [{ ...passage, text: 'x'.repeat(12_001) }] },
      { reranked: true, passages: [passage], extra: true },
    ]) {
      expect(
        (
          await rejects(
            withGezelKnowledge(
              app(async () => raw),
              messages,
              new AbortController().signal,
            ),
          )
        ).code,
      ).to.equal('unknown');
    }
    expect(
      (await rejects(withGezelKnowledge({} as GezelApp, messages, new AbortController().signal)))
        .code,
    ).to.equal('unsupported');
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
  it('accounts for serialized evidence in the selected model context budget', async () => {
    const result = withGezelKnowledge(
      app(async (request) => ({
        reranked: true,
        passages: [{ ...passage, text: '\\'.repeat(request.maxCharacters as number) }],
      })),
      messages,
      new AbortController().signal,
      4096,
    );
    expect((await rejects(result)).code).to.equal('budget-exceeded');
  });
});
