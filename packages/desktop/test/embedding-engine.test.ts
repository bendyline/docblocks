import { expect } from 'chai';
import {
  EmbeddingEngine,
  EmbeddingEngineError,
  type EmbeddingChannel,
} from '../main/embeddings/embedding-engine.js';
import {
  EmbeddingRuntime,
  type EmbeddingUtilityReply,
  type EmbeddingUtilityRequest,
} from '../main/embeddings/embedding-runtime.js';

/** A utility process stand-in that runs `EmbeddingRuntime` in-process. */
function fakeUtility(options: { hold?: boolean; loadFails?: number } = {}) {
  const sent: EmbeddingUtilityRequest[] = [];
  const channels: Array<{ killed: boolean; exit: (code: number) => void }> = [];
  let loadFailures = options.loadFails ?? 0;
  const held: Array<() => void> = [];
  let hold = options.hold ?? false;
  const fork = (): EmbeddingChannel => {
    let onMessage: (reply: EmbeddingUtilityReply) => void = () => undefined;
    let onExit: (code: number) => void = () => undefined;
    const runtime = new EmbeddingRuntime(async () => {
      if (loadFailures-- > 0) throw new Error('model files damaged');
      return {
        embedPassages: async (texts) => texts.map((text) => [text.length, 0]),
        embedQuery: async (text) => [0, text.length],
      };
    });
    const state = { killed: false, exit: (code: number) => onExit(code) };
    channels.push(state);
    return {
      postMessage: (message) => {
        sent.push(message);
        const run = () =>
          runtime.handle(message, (reply) => {
            if (!state.killed) onMessage(reply);
          });
        if (hold) held.push(run);
        else run();
      },
      onMessage: (listener) => {
        onMessage = listener;
      },
      onExit: (listener) => {
        onExit = listener;
      },
      kill: () => {
        state.killed = true;
      },
    };
  };
  return {
    fork,
    sent,
    channels,
    release: () => {
      hold = false;
      for (const run of held.splice(0)) run();
    },
  };
}

describe('embedding engine (main side)', () => {
  it('embeds through the utility, passing the model directory and kind', async () => {
    const utility = fakeUtility();
    const engine = new EmbeddingEngine({ fork: utility.fork, modelDir: '/models' });
    const passages = await engine.embed('passage', ['abc', 'de']);
    expect(passages.map((vector) => Array.from(vector))).to.deep.equal([
      [3, 0],
      [2, 0],
    ]);
    const [query] = await engine.embed('query', ['heron']);
    expect(Array.from(query as Float32Array)).to.deep.equal([0, 5]);
    expect(utility.sent.map(({ kind, modelDir }) => ({ kind, modelDir }))).to.deep.equal([
      { kind: 'passage', modelDir: '/models' },
      { kind: 'query', modelDir: '/models' },
    ]);
    expect(utility.channels).to.have.length(1);
    engine.dispose();
  });

  it('runs a query ahead of passage batches already queued', async () => {
    const utility = fakeUtility({ hold: true });
    const engine = new EmbeddingEngine({ fork: utility.fork, modelDir: '/models' });
    const order: string[] = [];
    const first = engine.embed('passage', ['one']).then(() => order.push('passage 1'));
    const second = engine.embed('passage', ['two']).then(() => order.push('passage 2'));
    const query = engine.embed('query', ['q']).then(() => order.push('query'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    utility.release();
    await Promise.all([first, second, query]);
    expect(order).to.deep.equal(['passage 1', 'query', 'passage 2']);
    engine.dispose();
  });

  it('replaces a stalled utility and limits respawns', async () => {
    const utility = fakeUtility({ hold: true });
    const engine = new EmbeddingEngine({
      fork: utility.fork,
      modelDir: '/models',
      loadTimeoutMs: 10,
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const error = await engine.embed('passage', ['x']).catch((caught: unknown) => caught);
      expect((error as EmbeddingEngineError).code).to.equal('timeout');
    }
    expect(utility.channels.every((channel) => channel.killed)).to.equal(true);
    const limited = await engine.embed('passage', ['x']).catch((caught: unknown) => caught);
    expect((limited as EmbeddingEngineError).code).to.equal('engine-failed');
    engine.dispose();
  });

  it('fails the running batch when the utility exits, then starts a fresh one', async () => {
    const utility = fakeUtility({ hold: true });
    const engine = new EmbeddingEngine({ fork: utility.fork, modelDir: '/models' });
    const running = engine.embed('passage', ['x']).catch((caught: unknown) => caught);
    await new Promise((resolve) => setTimeout(resolve, 0));
    utility.channels[0]?.exit(9);
    expect(((await running) as EmbeddingEngineError).message).to.contain('stopped');
    utility.release();
    const next = engine.embed('query', ['y']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    utility.release();
    expect(await next).to.have.length(1);
    expect(utility.channels).to.have.length(2);
    engine.dispose();
  });

  it('reports a model that will not load, and loads again on the next batch', async () => {
    const utility = fakeUtility({ loadFails: 1 });
    const engine = new EmbeddingEngine({ fork: utility.fork, modelDir: '/models' });
    const error = await engine.embed('passage', ['x']).catch((caught: unknown) => caught);
    expect((error as Error).message).to.equal('model files damaged');
    expect(await engine.embed('passage', ['x'])).to.have.length(1);
    expect(utility.channels).to.have.length(1);
    engine.dispose();
  });

  it('drops a queued batch whose caller gave up, and rejects everything on dispose', async () => {
    const utility = fakeUtility({ hold: true });
    const engine = new EmbeddingEngine({ fork: utility.fork, modelDir: '/models' });
    const running = engine.embed('passage', ['a']).catch((caught: unknown) => caught);
    const controller = new AbortController();
    const abandoned = engine
      .embed('passage', ['b'], controller.signal)
      .catch((caught: unknown) => caught);
    controller.abort();
    expect(((await abandoned) as EmbeddingEngineError).code).to.equal('cancelled');
    const queued = engine.embed('passage', ['c']).catch((caught: unknown) => caught);
    engine.dispose();
    expect(((await running) as EmbeddingEngineError).code).to.equal('cancelled');
    expect(((await queued) as EmbeddingEngineError).code).to.equal('cancelled');
    expect(utility.sent.map((request) => request.texts[0])).to.deep.equal(['a']);
  });
});
