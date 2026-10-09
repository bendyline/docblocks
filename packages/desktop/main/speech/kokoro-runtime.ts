import { readFile } from 'node:fs/promises';
import type { SpeechWordTiming } from '@bendyline/docblocks/host';
import { KokoroFrontend, styleOffset } from './kokoro-frontend.js';
import { kokoroWordTimings } from './kokoro-timing.js';

/**
 * The narration engine as it runs inside its utility process.
 *
 * It calls ONNX Runtime directly with Kokoro's three inputs — padded phoneme
 * ids, the voice's style vector for that length, and speed — which is all
 * kokoro-js's `generate_from_ids` does. Skipping kokoro-js also skips
 * transformers.js and the GPL eSpeak phonemizer it would otherwise import.
 *
 * Requests are served one at a time, each streamed back as one chunk per
 * utterance. ONNX Runtime is injected so the protocol can be tested without
 * the native addon.
 */

export const KOKORO_OUTPUT_SAMPLE_RATE = 24_000;

export interface OrtTensorLike {
  readonly data: unknown;
}

export interface OrtSessionLike {
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensorLike>>;
  release?(): Promise<void>;
}

export interface OrtLike {
  readonly InferenceSession: { create(path: string): Promise<OrtSessionLike> };
  readonly Tensor: new (
    type: 'int64' | 'float32',
    data: BigInt64Array | Float32Array,
    dims: readonly number[],
  ) => unknown;
}

export type KokoroRequest =
  | {
      readonly type: 'synthesize';
      readonly id: string;
      readonly modelFile: string;
      readonly voiceFile: string;
      readonly voice: string;
      readonly text: string;
      readonly speed: number;
      readonly lexiconDir: string;
    }
  | { readonly type: 'prepare'; readonly id: string; readonly modelFile: string }
  | { readonly type: 'cancel'; readonly id: string };

export type KokoroReply =
  | {
      readonly type: 'progress';
      readonly id: string;
      readonly phase: 'loading' | 'synthesizing';
      readonly completed: number;
      readonly total: number;
    }
  | {
      readonly type: 'chunk';
      readonly id: string;
      readonly index: number;
      readonly pcm: Float32Array;
      readonly sampleRate: number;
      readonly durationSec: number;
      readonly textStart: number;
      readonly textEnd: number;
      readonly wordTimings?: readonly SpeechWordTiming[];
    }
  | {
      readonly type: 'done';
      readonly id: string;
      readonly durationSec: number;
      readonly chunks: number;
    }
  | { readonly type: 'error'; readonly id: string; readonly message: string };

export class KokoroRuntime {
  private session: { readonly file: string; readonly session: OrtSessionLike } | null = null;
  private readonly voices = new Map<string, Float32Array>();
  private readonly frontends = new Map<string, KokoroFrontend>();
  private readonly cancelled = new Set<string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly ort: OrtLike) {}

  handle(request: KokoroRequest, post: (reply: KokoroReply) => void): void {
    if (request.type === 'cancel') {
      this.cancelled.add(request.id);
      return;
    }
    const run =
      request.type === 'prepare'
        ? () => this.prepare(request, post)
        : () => this.synthesize(request, post);
    this.queue = this.queue.then(run, run);
  }

  private async load(modelFile: string): Promise<OrtSessionLike> {
    if (this.session?.file === modelFile) return this.session.session;
    await this.session?.session.release?.();
    this.session = null;
    const session = await this.ort.InferenceSession.create(modelFile);
    this.session = { file: modelFile, session };
    return session;
  }

  private async prepare(
    request: Extract<KokoroRequest, { type: 'prepare' }>,
    post: (reply: KokoroReply) => void,
  ): Promise<void> {
    try {
      await this.load(request.modelFile);
      post({ type: 'done', id: request.id, durationSec: 0, chunks: 0 });
    } catch (error) {
      post({ type: 'error', id: request.id, message: messageOf(error) });
    }
  }

  private async voice(file: string): Promise<Float32Array> {
    const cached = this.voices.get(file);
    if (cached) return cached;
    const bytes = await readFile(file);
    // Copy out of Node's pooled buffer: the view must start at its own offset.
    const vectors = new Float32Array(bytes.byteLength / Float32Array.BYTES_PER_ELEMENT);
    new Uint8Array(vectors.buffer).set(bytes);
    this.voices.set(file, vectors);
    return vectors;
  }

  private frontend(lexiconDir: string): KokoroFrontend {
    let frontend = this.frontends.get(lexiconDir);
    if (!frontend) {
      frontend = new KokoroFrontend(lexiconDir);
      this.frontends.set(lexiconDir, frontend);
    }
    return frontend;
  }

  private async synthesize(
    request: Extract<KokoroRequest, { type: 'synthesize' }>,
    post: (reply: KokoroReply) => void,
  ): Promise<void> {
    const { id } = request;
    try {
      if (this.cancelled.has(id)) return;
      const total = request.text.length;
      if (this.session?.file !== request.modelFile) {
        post({ type: 'progress', id, phase: 'loading', completed: 0, total });
      }
      const [session, voice, utterances] = await Promise.all([
        this.load(request.modelFile),
        this.voice(request.voiceFile),
        this.frontend(request.lexiconDir).plan(request.text, request.voice),
      ]);
      const speed = Math.min(2, Math.max(0.5, request.speed));
      let durationSec = 0;
      let index = 0;
      for (const utterance of utterances) {
        // Cancellation lands between utterances; an in-flight run finishes.
        if (this.cancelled.has(id)) return;
        post({
          type: 'progress',
          id,
          phase: 'synthesizing',
          completed: utterance.textStart,
          total,
        });
        const offset = styleOffset(utterance.tokens.length);
        const output = await session.run({
          input_ids: new this.ort.Tensor(
            'int64',
            BigInt64Array.from(utterance.tokens, (token) => BigInt(token)),
            [1, utterance.tokens.length],
          ),
          style: new this.ort.Tensor('float32', voice.slice(offset, offset + 256), [1, 256]),
          speed: new this.ort.Tensor('float32', new Float32Array([speed]), [1]),
        });
        const waveform = output.waveform?.data;
        if (!(waveform instanceof Float32Array)) throw new Error('Kokoro returned no audio.');
        const seconds = waveform.length / KOKORO_OUTPUT_SAMPLE_RATE;
        const wordTimings = kokoroWordTimings(utterance, output.durations?.data, waveform.length);
        durationSec += seconds;
        post({
          type: 'chunk',
          id,
          index,
          pcm: waveform,
          sampleRate: KOKORO_OUTPUT_SAMPLE_RATE,
          durationSec: seconds,
          textStart: utterance.textStart,
          textEnd: utterance.textEnd,
          ...(wordTimings !== undefined ? { wordTimings } : {}),
        });
        index += 1;
      }
      if (index === 0) throw new Error('There is nothing to read aloud in that text.');
      post({ type: 'done', id, durationSec, chunks: index });
    } catch (error) {
      post({ type: 'error', id, message: messageOf(error) });
    } finally {
      this.cancelled.delete(id);
    }
  }
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}
