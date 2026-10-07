import { expect } from 'chai';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {
  KokoroFrontend,
  kokoroLanguageForVoice,
  kokoroLexiconDir,
  onnxRuntimeBinding,
  splitSentences,
  styleOffset,
} from '../main/speech/kokoro-frontend.js';
import {
  KokoroRuntime,
  type KokoroReply,
  type KokoroRequest,
  type OrtLike,
} from '../main/speech/kokoro-runtime.js';
import {
  KokoroEngine,
  KokoroEngineError,
  type KokoroChannel,
} from '../main/speech/kokoro-engine.js';
import { KOKORO_VOICE_BYTES } from '../main/speech/speech-models.js';

const require = createRequire(import.meta.url);
const LEXICON_DIR = kokoroLexiconDir(require.resolve('@bendyline/gezel-service/package.json'));

/** A fake ONNX Runtime: 100 samples of audio per input token. */
function fakeOrt(options: { failLoad?: boolean; runs?: number[] } = {}): OrtLike {
  class Tensor {
    constructor(
      readonly type: string,
      readonly data: BigInt64Array | Float32Array,
      readonly dims: readonly number[],
    ) {}
  }
  return {
    Tensor,
    InferenceSession: {
      async create() {
        if (options.failLoad) throw new Error('bad model');
        return {
          async run(feeds: Record<string, unknown>) {
            const ids = (feeds.input_ids as Tensor).data;
            options.runs?.push(ids.length);
            return { waveform: { data: new Float32Array(ids.length * 100).fill(0.25) } };
          },
        };
      },
    },
  };
}

describe('Kokoro frontend', () => {
  it('finds the pronunciation dictionaries in the installed Gezel service', () => {
    // Fails loudly if a Gezel release moves them.
    expect(existsSync(path.join(LEXICON_DIR, 'lexicon-us-en.txt.gz'))).to.equal(true);
    expect(existsSync(path.join(LEXICON_DIR, 'lexicon-gb-en.txt.gz'))).to.equal(true);
  });

  it('resolves the ONNX Runtime binding for this platform', () => {
    const binding = onnxRuntimeBinding(require.resolve('onnxruntime-node/package.json'));
    if (process.platform === 'darwin' && process.arch === 'x64') {
      expect(existsSync(binding)).to.equal(false);
    } else {
      expect(existsSync(binding)).to.equal(true);
    }
  });

  it('splits sentences and keeps their offsets in the source text', () => {
    const text = '  First one.  Second?\nThird…  ';
    const sentences = splitSentences(text);
    expect(sentences.map((s) => s.text)).to.deep.equal(['First one.', 'Second?', 'Third…']);
    for (const sentence of sentences) {
      expect(text.slice(sentence.start, sentence.end)).to.equal(sentence.text);
    }
  });

  it('picks the British dictionary for b* voices', () => {
    expect(kokoroLanguageForVoice('bf_emma')).to.equal('gb');
    expect(kokoroLanguageForVoice('af_heart')).to.equal('us');
  });

  it('plans padded utterances per sentence with offsets', async () => {
    const text = 'Hello world. It costs $3.50 today.';
    const utterances = await new KokoroFrontend(LEXICON_DIR).plan(text, 'af_heart');
    expect(utterances).to.have.length(2);
    expect(text.slice(utterances[1]!.textStart, utterances[1]!.textEnd)).to.equal(
      'It costs $3.50 today.',
    );
    for (const utterance of utterances) {
      expect(utterance.tokens[0]).to.equal(0);
      expect(utterance.tokens.at(-1)).to.equal(0);
    }
  });

  it('indexes style vectors like kokoro-js', () => {
    expect(styleOffset(2)).to.equal(0);
    expect(styleOffset(79)).to.equal(77 * 256);
    expect(styleOffset(10_000)).to.equal(509 * 256);
  });
});

describe('KokoroRuntime', () => {
  let root: string;
  let voiceFile: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'docblocks-kokoro-'));
    voiceFile = path.join(root, 'af_heart.bin');
    await writeFile(voiceFile, new Uint8Array(KOKORO_VOICE_BYTES));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function run(runtime: KokoroRuntime, request: KokoroRequest): Promise<KokoroReply[]> {
    return new Promise((resolve) => {
      const replies: KokoroReply[] = [];
      runtime.handle(request, (reply) => {
        replies.push(reply);
        if (reply.type === 'done' || reply.type === 'error') resolve(replies);
      });
    });
  }

  const synth = (text: string, id = 'r1'): KokoroRequest => ({
    type: 'synthesize',
    id,
    modelFile: '/models/kokoro.onnx',
    voiceFile,
    voice: 'af_heart',
    text,
    speed: 1,
    lexiconDir: LEXICON_DIR,
  });

  it('streams one chunk per sentence and then a summary', async () => {
    const replies = await run(new KokoroRuntime(fakeOrt()), synth('One sentence. Two sentences.'));
    const chunks = replies.filter((r) => r.type === 'chunk');
    expect(chunks).to.have.length(2);
    expect(replies[0]).to.include({ type: 'progress', phase: 'loading' });
    const done = replies.at(-1);
    expect(done?.type).to.equal('done');
    if (done?.type === 'done') expect(done.chunks).to.equal(2);
    if (chunks[1]?.type === 'chunk') {
      expect(chunks[1].sampleRate).to.equal(24_000);
      expect(chunks[1].textStart).to.equal('One sentence. '.length);
    }
  });

  it('serves requests one at a time and honours cancellation between utterances', async () => {
    const runs: number[] = [];
    const runtime = new KokoroRuntime(fakeOrt({ runs }));
    const first = run(runtime, synth('A. B. C.', 'a'));
    runtime.handle({ type: 'cancel', id: 'b' }, () => undefined);
    const second = new Promise<KokoroReply[]>((resolve) => {
      const replies: KokoroReply[] = [];
      runtime.handle(synth('D. E.', 'b'), (reply) => replies.push(reply));
      setTimeout(() => resolve(replies), 100);
    });
    expect((await first).filter((r) => r.type === 'chunk')).to.have.length(3);
    expect(await second).to.deep.equal([]);
  });

  it('reports load failures and empty text as errors', async () => {
    const failed = await run(new KokoroRuntime(fakeOrt({ failLoad: true })), synth('Hi.'));
    expect(failed.at(-1)).to.include({ type: 'error', message: 'bad model' });
    const empty = await run(new KokoroRuntime(fakeOrt()), synth('*** ###'));
    expect(empty.at(-1)?.type).to.equal('error');
  });
});

/** Runs a real KokoroRuntime over an in-memory channel, with knobs for failure. */
class FakeChannel implements KokoroChannel {
  static spawned = 0;
  private messageListener: (reply: KokoroReply) => void = () => undefined;
  private exitListener: (code: number) => void = () => undefined;
  killed = false;
  constructor(
    private readonly runtime: KokoroRuntime | null,
    private readonly behaviour: 'ok' | 'stall' | 'crash' = 'ok',
  ) {
    FakeChannel.spawned += 1;
  }
  postMessage(message: KokoroRequest): void {
    if (this.behaviour === 'stall') return;
    if (this.behaviour === 'crash') {
      setTimeout(() => this.exitListener(9), 5);
      return;
    }
    this.runtime?.handle(message, (reply) => {
      if (!this.killed) this.messageListener(reply);
    });
  }
  onMessage(listener: (reply: KokoroReply) => void): void {
    this.messageListener = listener;
  }
  onExit(listener: (code: number) => void): void {
    this.exitListener = listener;
  }
  kill(): void {
    this.killed = true;
  }
}

describe('KokoroEngine', () => {
  let root: string;
  let voiceFile: string;
  beforeEach(async () => {
    FakeChannel.spawned = 0;
    root = await mkdtemp(path.join(os.tmpdir(), 'docblocks-kokoro-engine-'));
    voiceFile = path.join(root, 'v.bin');
    await writeFile(voiceFile, new Uint8Array(KOKORO_VOICE_BYTES));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const input = (text = 'Read me. Then this.') => ({
    modelFile: '/m.onnx',
    voiceFile,
    voice: 'af_heart',
    text,
    speed: 1,
  });

  it('relays chunks as wire events and summarises the synthesis', async () => {
    const engine = new KokoroEngine({
      lexiconDir: LEXICON_DIR,
      fork: () => new FakeChannel(new KokoroRuntime(fakeOrt())),
    });
    const kinds: string[] = [];
    const summary = await engine.synthesize(input(), (event) => {
      kinds.push(event.kind);
      if (event.kind === 'chunk') expect(event.chunk.pcm).to.be.instanceOf(ArrayBuffer);
    });
    expect(kinds.filter((k) => k === 'chunk')).to.have.length(2);
    expect(summary).to.include({ voice: 'af_heart', model: 'kokoro-82m-v1.0', chunks: 2 });
    await engine.stop();
  });

  it('kills a stalled process, fails the request, and respawns for the next', async () => {
    let behaviour: 'stall' | 'ok' = 'stall';
    const channels: FakeChannel[] = [];
    const engine = new KokoroEngine({
      lexiconDir: LEXICON_DIR,
      loadTimeoutMs: 50,
      fork: () => {
        const channel = new FakeChannel(new KokoroRuntime(fakeOrt()), behaviour);
        channels.push(channel);
        return channel;
      },
    });
    let error: unknown;
    await engine
      .synthesize(input(), () => undefined)
      .catch((caught: unknown) => {
        error = caught;
      });
    expect((error as KokoroEngineError).code).to.equal('timeout');
    expect(channels[0]?.killed).to.equal(true);
    behaviour = 'ok';
    expect((await engine.synthesize(input('Again.'), () => undefined)).chunks).to.equal(1);
    expect(FakeChannel.spawned).to.equal(2);
  });

  it('fails in-flight work when the process exits, and stops respawning a crash loop', async () => {
    const engine = new KokoroEngine({
      lexiconDir: LEXICON_DIR,
      fork: () => new FakeChannel(null, 'crash'),
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let error: unknown;
      await engine
        .synthesize(input(), () => undefined)
        .catch((caught: unknown) => {
          error = caught;
        });
      expect((error as KokoroEngineError).code).to.equal('engine-failed');
    }
    let error: unknown;
    await engine
      .synthesize(input(), () => undefined)
      .catch((caught: unknown) => {
        error = caught;
      });
    expect((error as Error).message).to.contain('keeps stopping');
  });

  it('cancels a request without killing the process', async () => {
    const channels: FakeChannel[] = [];
    const engine = new KokoroEngine({
      lexiconDir: LEXICON_DIR,
      fork: () => {
        const channel = new FakeChannel(null, 'stall');
        channels.push(channel);
        return channel;
      },
    });
    const controller = new AbortController();
    const pending = engine.synthesize(input(), () => undefined, controller.signal);
    controller.abort();
    let error: unknown;
    await pending.catch((caught: unknown) => {
      error = caught;
    });
    expect((error as KokoroEngineError).code).to.equal('cancelled');
    expect(channels[0]?.killed).to.equal(false);
    await engine.stop();
  });

  it('unloads an idle process', async () => {
    const channels: FakeChannel[] = [];
    const engine = new KokoroEngine({
      lexiconDir: LEXICON_DIR,
      idleUnloadMs: 30,
      fork: () => {
        const channel = new FakeChannel(new KokoroRuntime(fakeOrt()));
        channels.push(channel);
        return channel;
      },
    });
    await engine.synthesize(input('Once.'), () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(channels[0]?.killed).to.equal(true);
  });
});

/**
 * Opt-in: the real model through real ONNX Runtime. Set
 * DOCBLOCKS_TEST_KOKORO_MODEL and DOCBLOCKS_TEST_KOKORO_VOICE to a downloaded
 * `model_quantized.onnx` and `af_heart.bin`.
 */
describe('KokoroRuntime with the real model', function () {
  const model = process.env.DOCBLOCKS_TEST_KOKORO_MODEL;
  const voice = process.env.DOCBLOCKS_TEST_KOKORO_VOICE;
  this.timeout(120_000);
  before(function () {
    if (!model || !voice || !existsSync(model) || !existsSync(voice)) this.skip();
  });

  it('speaks a sentence with audible output', async () => {
    const ort = require('onnxruntime-node') as OrtLike;
    const runtime = new KokoroRuntime(ort);
    const replies = await new Promise<KokoroReply[]>((resolve) => {
      const collected: KokoroReply[] = [];
      runtime.handle(
        {
          type: 'synthesize',
          id: 'real',
          modelFile: model!,
          voiceFile: voice!,
          voice: 'af_heart',
          text: 'DocBlocks can read your documents aloud.',
          speed: 1,
          lexiconDir: LEXICON_DIR,
        },
        (reply) => {
          collected.push(reply);
          if (reply.type === 'done' || reply.type === 'error') resolve(collected);
        },
      );
    });
    const chunk = replies.find((r) => r.type === 'chunk');
    expect(replies.at(-1)?.type).to.equal('done');
    if (chunk?.type !== 'chunk') throw new Error('no audio');
    const peak = chunk.pcm.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
    expect(chunk.durationSec).to.be.greaterThan(1);
    expect(peak).to.be.greaterThan(0.05);
  });
});
