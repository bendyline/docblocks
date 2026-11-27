import { expect } from 'chai';
import { GezelApp } from '@bendyline/gezel-app-sdk';
import { AppKnowledgeQuerySchema } from '@bendyline/gezel/app-models';
import { v1KnowledgeRoutes } from '@bendyline/gezel-inference/internal/http/routes/v1-knowledge';
import { AI_WIRE_LIMITS, parseAiWorkspacePassages } from '@bendyline/docblocks/host';
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
  state: () => Promise<unknown> = async () => ({
    catalogs: [{ id: 'science', name: 'Science Library', enabled: true }],
  }),
): GezelApp {
  return {
    knowledge: { retrieve, state, update: async () => undefined },
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
    expect(result.messages[0].content)
      .to.contain('untrusted source material')
      .and.contain(passage.uri)
      .and.contain(passage.text);
    expect(result.messages.slice(1)).to.deep.equal(messages);
  });
  it('keeps the prompt when no relevant knowledge is found', async () => {
    expect(
      await withGezelKnowledge(
        app(async () => ({ reranked: true, passages: [] })),
        messages,
        new AbortController().signal,
      ),
    ).to.deep.equal({ messages, knowledge: { outcome: 'none' } });
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
      ).to.deep.equal({ messages, knowledge: { outcome: 'skipped' } });
    }
    expect(
      await withGezelKnowledge({} as GezelApp, messages, new AbortController().signal),
    ).to.deep.equal({ messages, knowledge: null });
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
        { contextWindow: 4096 },
      ),
    ).to.deep.equal({ messages: long, knowledge: { outcome: 'skipped' } });
    expect(called).to.equal(false);
  });
  it('injects passages Gezel admitted without ranking', async () => {
    const result = await withGezelKnowledge(
      app(async () => ({ reranked: false, passages: [passage] })),
      messages,
      new AbortController().signal,
    );
    expect(result.messages[0].content).to.contain(passage.text);
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
      ).to.deep.equal({ messages, knowledge: { outcome: 'skipped' } });
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
      { contextWindow: 4096 },
    );
    expect(result).to.deep.equal({ messages, knowledge: { outcome: 'skipped' } });
  });
});

describe('workspace passages in Gezel knowledge', () => {
  const note = {
    uri: 'knowledge://local/ws-0123456789abcdef/garden/pests.md#line=3-5',
    title: 'Garden notes › Pests',
    text: 'Aphids gather under the leaves.',
  };

  it('hands workspace passages to Gezel as candidates and names the ones it chose', async () => {
    let observed: Record<string, unknown> | undefined;
    const result = await withGezelKnowledge(
      app(async (request) => {
        observed = request;
        // Gezel returns a chosen candidate under its collection, version `local`.
        return {
          reranked: true,
          passages: [passage, { ...note, catalogId: 'ws-0123456789abcdef', version: 'local' }],
        };
      }),
      messages,
      new AbortController().signal,
      { workspacePassages: [note] },
    );
    expect(observed?.candidates).to.deep.equal([note]);
    expect(result.messages[0].content).to.contain(passage.text);
    expect(result.messages[0].content).to.contain(note.text);
    expect(result.messages[0].content).to.contain(note.uri);
    expect(result.knowledge).to.deep.include({ outcome: 'used' });
    expect(result.knowledge?.outcome === 'used' && result.knowledge.sources).to.deep.equal([
      { catalogId: 'science', name: 'Science Library', titles: ['Science'] },
      { catalogId: 'workspace', name: 'This workspace', titles: ['Garden notes › Pests'] },
    ]);
  });

  it('still grounds a request in workspace passages when catalog retrieval fails', async () => {
    const result = await withGezelKnowledge(
      app(async () => {
        throw Object.assign(new Error('busy'), { code: 'rate_limited' });
      }),
      messages,
      new AbortController().signal,
      { workspacePassages: [note] },
    );
    expect(result.messages[0].content).to.contain(note.text);
    expect(result.knowledge?.outcome === 'used' && result.knowledge.sources).to.deep.equal([
      { catalogId: 'workspace', name: 'This workspace', titles: ['Garden notes › Pests'] },
    ]);
  });

  it('grounds a request in workspace passages where Gezel offers no catalogs', async () => {
    const result = await withGezelKnowledge(
      {} as GezelApp,
      messages,
      new AbortController().signal,
      { catalogs: false, workspacePassages: [note] },
    );
    expect(result.messages[0].content).to.contain(note.text);
    expect(result.knowledge?.outcome === 'used' && result.knowledge.sources).to.deep.equal([
      { catalogId: 'workspace', name: 'This workspace', titles: ['Garden notes › Pests'] },
    ]);
  });
});

/**
 * Gezel's own `/v1/knowledge` routes behind the real SDK client, over stub
 * catalogs and a stub relevance scorer: what a desktop request with workspace
 * passages gets from the installed Gezel. The routes are Gezel internals, so a
 * Gezel bump that moves them fails here, at the bump.
 */
describe('workspace passages through Gezel’s knowledge route', () => {
  const notes = [
    {
      uri: 'knowledge://local/ws-0123456789abcdef/garden/pests.md#line=3-5',
      title: 'Garden notes › Pests',
      text: 'Aphids gather under the rose leaves in May.',
    },
    {
      uri: 'knowledge://local/ws-0123456789abcdef/travel/lisbon.md#line=1-4',
      title: 'Lisbon trip',
      text: 'Tram 28 climbs to the castle.',
    },
  ];
  const article = 'Photosynthesis turns light into sugar in the leaves.';

  function gezel(options: { catalog: boolean; scores?: Record<string, number> }) {
    const scored: string[][] = [];
    const catalogUri = 'knowledge://bendyline/science/photosynthesis';
    const relevance = {
      status: async () => ({
        models: [{ id: 'relevance', installed: options.scores !== undefined, approxBytes: 1 }],
        modelId: 'relevance',
        status: 'ready',
      }),
      forSurface: async () =>
        options.scores ? { model: 'relevance', thresholds: { keep: 0.5 } } : null,
      scorer: {
        score: async ({ passages }: { passages: string[] }) => {
          scored.push(passages);
          return { status: 'scored', scores: passages.map((text) => options.scores?.[text] ?? 0) };
        },
      },
    };
    const knowledge = {
      list: async () =>
        options.catalog
          ? [
              {
                enabled: true,
                mounted: true,
                source: 'registry',
                name: 'Science Library',
                ref: { catalogId: 'science', version: '1' },
                updateAvailable: false,
              },
            ]
          : [],
      available: async () => [],
      activeInstalls: () => [],
      getJob: () => undefined,
      // A vector hit above Gezel's bar for passages its model has not judged.
      searchUnified: async () => [
        { uri: catalogUri, arm: 'vector', kind: 'knowledge', score: 1, relevance: 0.9 },
      ],
      resolveCitation: async () => ({
        ok: true,
        title: 'Photosynthesis',
        chunk: { text: article },
        uri: { catalogId: 'science' },
        catalogVersion: '1',
      }),
    };
    const routes = v1KnowledgeRoutes({ knowledge, relevance } as unknown as Parameters<
      typeof v1KnowledgeRoutes
    >[0]);
    const fetchRoutes: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return routes.fetch(
        new Request(`http://gezel${url.pathname.replace('/v1/knowledge', '')}`, init),
      );
    };
    return {
      app: new GezelApp({ baseUrl: 'http://gezel', token: 'token', fetch: fetchRoutes }),
      scored,
    };
  }
  const ask = (target: GezelApp) =>
    withGezelKnowledge(
      target,
      [{ role: 'user', content: 'What eats my roses?' }],
      new AbortController().signal,
      { citations: true, workspacePassages: notes },
    );
  const evidence = (result: Awaited<ReturnType<typeof ask>>) =>
    result.knowledge?.outcome === 'used'
      ? result.knowledge.evidence.map((entry) => [entry.catalogId, entry.text])
      : result.knowledge;

  it('judges notes and catalog passages together and keeps only what clears its bar', async () => {
    const { app: target, scored } = gezel({
      catalog: true,
      scores: { [notes[0].text]: 0.9, [article]: 0.7, [notes[1].text]: 0.1 },
    });
    const result = await ask(target);
    expect(scored).to.deep.equal([[article, notes[0].text, notes[1].text]]);
    expect(evidence(result)).to.deep.equal([
      ['workspace', notes[0].text],
      ['science', article],
    ]);
    expect(result.knowledge?.outcome === 'used' && result.knowledge.sources).to.deep.equal([
      { catalogId: 'workspace', name: 'This workspace', titles: ['Garden notes › Pests'] },
      { catalogId: 'science', name: 'Science Library', titles: ['Photosynthesis'] },
    ]);
    expect(result.messages[0].content).to.contain(notes[0].uri).and.not.contain(notes[1].text);
  });

  it('takes turns with catalog passages, a catalog passage first, without the model', async () => {
    const { app: target, scored } = gezel({ catalog: true });
    expect(evidence(await ask(target))).to.deep.equal([
      ['science', article],
      ['workspace', notes[0].text],
      ['workspace', notes[1].text],
    ]);
    expect(scored).to.deep.equal([]);
  });

  it('judges notes alone where no catalog is enabled', async () => {
    const { app: target } = gezel({
      catalog: false,
      scores: { [notes[0].text]: 0.8, [notes[1].text]: 0.2 },
    });
    expect(evidence(await ask(target))).to.deep.equal([['workspace', notes[0].text]]);
    const none = await ask(gezel({ catalog: false, scores: {} }).app);
    expect(none.knowledge).to.deep.equal({ outcome: 'none' });
  });

  it('accepts every workspace passage DocBlocks puts on the wire', () => {
    const longest = `${'n'.repeat(250)}.md`;
    const passages = parseAiWorkspacePassages(
      Array.from({ length: AI_WIRE_LIMITS.workspacePassages }, (_, index) => ({
        uri: `knowledge://local/ws-0123456789abcdef/${longest}#line=${index}-999999999`,
        title: 't'.repeat(AI_WIRE_LIMITS.knowledgeTitleCharacters),
        text: 'x'.repeat(
          AI_WIRE_LIMITS.workspacePassagesCharacters / AI_WIRE_LIMITS.workspacePassages,
        ),
      })),
    );
    expect(passages).to.have.length(AI_WIRE_LIMITS.workspacePassages);
    expect(AppKnowledgeQuerySchema.shape.candidates.safeParse(passages).success).to.equal(true);
    const single = parseAiWorkspacePassages([
      { ...notes[0], text: 'x'.repeat(AI_WIRE_LIMITS.workspacePassageCharacters) },
    ]);
    expect(AppKnowledgeQuerySchema.shape.candidates.safeParse(single).success).to.equal(true);
  });
});

describe('Gezel knowledge reported to the renderer', () => {
  it('names the catalogs and distinct articles a request cited', async () => {
    const result = await withGezelKnowledge(
      app(async () => ({
        reranked: true,
        passages: [
          passage,
          { ...passage, uri: 'knowledge://publisher/science/article#2', text: 'More.' },
          { ...passage, uri: 'knowledge://publisher/physics/a', title: ' Physics ' },
          { ...passage, uri: 'knowledge://publisher/law/a', title: 'Statute', catalogId: 'law' },
        ],
      })),
      messages,
      new AbortController().signal,
    );
    expect(result.knowledge).to.deep.equal({
      outcome: 'used',
      sources: [
        { catalogId: 'science', name: 'Science Library', titles: ['Science', 'Physics'] },
        // Not in the catalog state: named by its id rather than left out.
        { catalogId: 'law', name: 'law', titles: ['Statute'] },
      ],
      // Every passage the model saw, for checking its output against.
      evidence: [
        { title: 'Science', catalogId: 'science', text: 'A cited fact.', uri: passage.uri },
        {
          title: 'Science',
          catalogId: 'science',
          text: 'More.',
          uri: 'knowledge://publisher/science/article#2',
        },
        {
          title: 'Physics',
          catalogId: 'science',
          text: 'A cited fact.',
          uri: 'knowledge://publisher/physics/a',
        },
        {
          title: 'Statute',
          catalogId: 'law',
          text: 'A cited fact.',
          uri: 'knowledge://publisher/law/a',
        },
      ],
    });
  });
  it('says nothing about knowledge when no catalog is enabled', async () => {
    const result = await withGezelKnowledge(
      app(
        async () => ({ reranked: true, passages: [] }),
        async () => ({ catalogs: [{ id: 'science', name: 'Science', enabled: false }] }),
      ),
      messages,
      new AbortController().signal,
    );
    expect(result).to.deep.equal({ messages, knowledge: null });
  });
  it('still reports citations when catalog state cannot be read', async () => {
    const result = await withGezelKnowledge(
      app(
        async () => ({ reranked: true, passages: [passage] }),
        async () => {
          throw Object.assign(new Error('busy'), { code: 'rate_limited' });
        },
      ),
      messages,
      new AbortController().signal,
    );
    expect(result.knowledge).to.deep.equal({
      outcome: 'used',
      sources: [{ catalogId: 'science', name: 'science', titles: ['Science'] }],
      evidence: [
        { title: 'Science', catalogId: 'science', text: 'A cited fact.', uri: passage.uri },
      ],
    });
    // Without state, "nothing matched" cannot be told from "nothing enabled".
    const none = await withGezelKnowledge(
      app(
        async () => ({ reranked: true, passages: [] }),
        async () => {
          throw new Error('busy');
        },
      ),
      messages,
      new AbortController().signal,
    );
    expect(none.knowledge).to.equal(null);
  });
  it('reads catalog state once per interval, not once per request', async () => {
    let reads = 0;
    const shared = app(
      async () => ({ reranked: true, passages: [] }),
      async () => {
        reads += 1;
        return { catalogs: [{ id: 'science', name: 'Science', enabled: true }] };
      },
    );
    for (let index = 0; index < 3; index += 1) {
      await withGezelKnowledge(shared, messages, new AbortController().signal);
    }
    expect(reads).to.equal(1);
  });
  it('reads catalog state again after a catalog is enabled or disabled', async () => {
    let enabled = false;
    const shared = app(
      async () => ({ reranked: true, passages: [] }),
      async () => ({ catalogs: [{ id: 'science', name: 'Science', enabled }] }),
    );
    const signal = new AbortController().signal;
    expect((await withGezelKnowledge(shared, messages, signal)).knowledge).to.equal(null);
    enabled = true;
    await updateGezelKnowledge(shared, { action: 'enable', catalogId: 'science' }, signal);
    expect((await withGezelKnowledge(shared, messages, signal)).knowledge).to.deep.equal({
      outcome: 'none',
    });
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
    expect(actions).to.deep.equal([{ action: 'prepare-reranker' }]);
  });
  // A catalog in use finds next to nothing until the model that judges its
  // passages is installed, so the model is part of adding a catalog.
  it('starts the relevance model download when a catalog is installed or enabled', async () => {
    const signal = new AbortController().signal;
    for (const action of ['install', 'enable'] as const) {
      const actions: unknown[] = [];
      await updateGezelKnowledge(stateApp({}, actions), { action, catalogId: 'science' }, signal);
      expect(actions, action).to.deep.equal([
        { action, catalogId: 'science' },
        { action: 'prepare-reranker' },
      ]);
    }
    // Nothing else puts a catalog to use.
    for (const action of ['disable', 'remove', 'cancel'] as const) {
      const actions: unknown[] = [];
      await updateGezelKnowledge(stateApp({}, actions), { action, catalogId: 'science' }, signal);
      expect(actions, action).to.deep.equal([{ action, catalogId: 'science' }]);
    }
  });
  it('keeps a catalog change when the relevance model download is refused', async () => {
    const actions: unknown[] = [];
    const refusing = {
      knowledge: {
        update: async (action: { action: string }) => {
          actions.push(action);
          if (action.action === 'prepare-reranker') {
            throw Object.assign(new Error('No relevance model is configured.'), {
              code: 'reranker_unavailable',
            });
          }
        },
      },
    } as unknown as GezelApp;
    const warnings: unknown[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args[0]);
    try {
      await updateGezelKnowledge(
        refusing,
        { action: 'install', catalogId: 'science' },
        new AbortController().signal,
      );
    } finally {
      console.warn = warn;
    }
    expect(actions).to.deep.equal([
      { action: 'install', catalogId: 'science' },
      { action: 'prepare-reranker' },
    ]);
    expect(warnings).to.have.length(1);
    expect(String(warnings[0])).to.contain('No relevance model is configured.');
  });
  it('does not ask for the relevance model when the catalog change itself fails', async () => {
    const actions: unknown[] = [];
    const failing = {
      knowledge: {
        update: async (action: unknown) => {
          actions.push(action);
          throw Object.assign(new Error('That catalog is not available.'), {
            code: 'catalog_not_found',
          });
        },
      },
    } as unknown as GezelApp;
    let thrown: unknown;
    try {
      await updateGezelKnowledge(
        failing,
        { action: 'install', catalogId: 'missing' },
        new AbortController().signal,
      );
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).to.be.instanceOf(Error);
    expect(actions).to.deep.equal([{ action: 'install', catalogId: 'missing' }]);
  });
});

describe('Gezel knowledge for cited drafts', () => {
  it('searches for what the person asked rather than the templated prompt', async () => {
    let observed: Record<string, unknown> | undefined;
    await withGezelKnowledge(
      app(async (request) => {
        observed = request;
        return { reranked: true, passages: [] };
      }),
      [
        {
          role: 'user',
          content: `Instructions:\nWrite about science.\n\n<document>${'x'.repeat(9000)}`,
        },
      ],
      new AbortController().signal,
      { query: 'Write about science.\nNotes' },
    );
    expect(observed).to.include({ query: 'Write about science.\nNotes' });
  });

  it('numbers passages for citation only when the caller checks citations', async () => {
    const two = async () => ({
      reranked: true,
      passages: [passage, { ...passage, uri: 'knowledge://publisher/science/b', title: 'B' }],
    });
    const cited = await withGezelKnowledge(app(two), messages, new AbortController().signal, {
      citations: true,
    });
    expect(cited.messages[0].content).to.contain('"cite":"[1]"').and.contain('"cite":"[2]"');
    // The model was asked to cite evidence[0] as [1].
    expect(cited.knowledge).to.deep.include({
      evidence: [
        { title: 'Science', catalogId: 'science', text: 'A cited fact.', uri: passage.uri },
        {
          title: 'B',
          catalogId: 'science',
          text: 'A cited fact.',
          uri: 'knowledge://publisher/science/b',
        },
      ],
    });
    const plain = await withGezelKnowledge(app(two), messages, new AbortController().signal);
    expect(plain.messages[0].content).not.to.contain('"cite"');
  });
});
