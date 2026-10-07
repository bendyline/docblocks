import type { SpeechSynthesisSummary, SpeechSynthesizeEvent } from '@bendyline/docblocks/host';
import { KOKORO_MODEL_ID } from './speech-models.js';
import type { KokoroReply, KokoroRequest } from './kokoro-runtime.js';
import type { TtsEngine, TtsSynthesisInput } from './speech-service.js';

/**
 * Main's side of the narration engine: owns the utility process that runs
 * ONNX Runtime, correlates its replies, and keeps it healthy.
 *
 * Gezel runs Kokoro on a worker thread and must never terminate it mid-run,
 * because an aborted ONNX inference takes the whole process with it. A utility
 * process has no such rule — killing it costs only a respawn — so a stall is
 * handled by killing and starting fresh.
 */

export interface KokoroChannel {
  postMessage(message: KokoroRequest): void;
  onMessage(listener: (reply: KokoroReply) => void): void;
  onExit(listener: (code: number) => void): void;
  kill(): void;
}

export interface KokoroEngineOptions {
  readonly fork: () => KokoroChannel;
  /** Where the Kokoro pronunciation dictionaries live. Main-authoritative. */
  readonly lexiconDir: string;
  /** Allowed silence before the first chunk (model load included). */
  readonly loadTimeoutMs?: number;
  /** Allowed silence between chunks once audio is flowing. */
  readonly chunkTimeoutMs?: number;
  readonly idleUnloadMs?: number;
  readonly now?: () => number;
}

export class KokoroEngineError extends Error {
  constructor(
    readonly code: 'engine-failed' | 'timeout' | 'cancelled',
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'KokoroEngineError';
  }
}

interface Pending {
  readonly onReply: (reply: KokoroReply) => void;
  readonly fail: (error: KokoroEngineError) => void;
  timer: ReturnType<typeof setTimeout> | null;
  started: boolean;
}

const RESPAWN_WINDOW_MS = 60_000;
const MAX_SPAWNS_PER_WINDOW = 3;

export class KokoroEngine implements TtsEngine {
  private channel: KokoroChannel | null = null;
  private readonly pending = new Map<string, Pending>();
  private spawns: number[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private sequence = 0;

  constructor(private readonly options: KokoroEngineOptions) {}

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  private ensureChannel(): KokoroChannel {
    if (this.channel) return this.channel;
    const now = this.now;
    this.spawns = this.spawns.filter((at) => now - at < RESPAWN_WINDOW_MS);
    if (this.spawns.length >= MAX_SPAWNS_PER_WINDOW) {
      throw new KokoroEngineError(
        'engine-failed',
        'The narration engine keeps stopping. Try again in a minute.',
      );
    }
    this.spawns.push(now);
    const channel = this.options.fork();
    channel.onMessage((reply) => {
      if (this.channel !== channel) return;
      this.pending.get(reply.id)?.onReply(reply);
    });
    channel.onExit((code) => {
      if (this.channel !== channel) return;
      this.channel = null;
      this.failAll(
        new KokoroEngineError('engine-failed', 'The narration engine stopped.', `exit ${code}`),
      );
    });
    this.channel = channel;
    return channel;
  }

  private failAll(error: KokoroEngineError): void {
    for (const pending of [...this.pending.values()]) pending.fail(error);
  }

  /** Kill the process; the next request starts a fresh one. */
  private discard(): void {
    const channel = this.channel;
    this.channel = null;
    channel?.kill();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private armIdle(): void {
    this.clearIdle();
    if (this.pending.size > 0 || !this.channel) return;
    this.idleTimer = setTimeout(
      () => {
        // Unloading frees the model's memory; the next request reloads it.
        if (this.pending.size === 0) this.discard();
      },
      this.options.idleUnloadMs ?? 5 * 60_000,
    );
    this.idleTimer.unref?.();
  }

  /**
   * Send one request and route its replies until `done` or `error`. The stall
   * watchdog restarts on every reply.
   */
  private request(
    message: KokoroRequest,
    onReply: (reply: KokoroReply) => void,
    signal?: AbortSignal,
  ): Promise<Extract<KokoroReply, { type: 'done' }>> {
    if (signal?.aborted) {
      return Promise.reject(new KokoroEngineError('cancelled', 'Narration stopped.'));
    }
    const channel = this.ensureChannel();
    this.clearIdle();
    return new Promise((resolve, reject) => {
      const loadTimeout = this.options.loadTimeoutMs ?? 5 * 60_000;
      const chunkTimeout = this.options.chunkTimeoutMs ?? 60_000;
      const settle = () => {
        if (entry.timer) clearTimeout(entry.timer);
        this.pending.delete(message.id);
        signal?.removeEventListener('abort', onAbort);
        this.armIdle();
      };
      const arm = () => {
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = setTimeout(
          () => {
            const error = new KokoroEngineError(
              'timeout',
              'The narration engine stopped responding.',
            );
            // A wedged inference cannot be interrupted; replace the process.
            this.discard();
            this.failAll(error);
          },
          entry.started ? chunkTimeout : loadTimeout,
        );
      };
      const entry: Pending = {
        timer: null,
        started: false,
        fail: (error) => {
          settle();
          reject(error);
        },
        onReply: (reply) => {
          if (reply.type === 'chunk') entry.started = true;
          if (reply.type === 'done') {
            settle();
            resolve(reply);
          } else if (reply.type === 'error') {
            settle();
            reject(new KokoroEngineError('engine-failed', reply.message));
          } else {
            arm();
            onReply(reply);
          }
        },
      };
      const onAbort = () => {
        channel.postMessage({ type: 'cancel', id: message.id });
        entry.fail(new KokoroEngineError('cancelled', 'Narration stopped.'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(message.id, entry);
      arm();
      channel.postMessage(message);
    });
  }

  private nextId(): string {
    this.sequence += 1;
    return `tts-${this.sequence}`;
  }

  async prepare(modelFile: string, signal?: AbortSignal): Promise<void> {
    await this.request({ type: 'prepare', id: this.nextId(), modelFile }, () => undefined, signal);
  }

  async synthesize(
    input: TtsSynthesisInput,
    onEvent: (event: Exclude<SpeechSynthesizeEvent, { kind: 'done' | 'error' }>) => void,
    signal?: AbortSignal,
  ): Promise<SpeechSynthesisSummary> {
    let sampleRate = 24_000;
    const done = await this.request(
      {
        type: 'synthesize',
        id: this.nextId(),
        modelFile: input.modelFile,
        voiceFile: input.voiceFile,
        voice: input.voice,
        text: input.text,
        speed: input.speed,
        lexiconDir: this.options.lexiconDir,
      },
      (reply) => {
        if (reply.type === 'progress') {
          onEvent({
            kind: 'progress',
            phase: reply.phase,
            completedCharacters: Math.min(reply.completed, reply.total),
            totalCharacters: reply.total,
          });
        } else if (reply.type === 'chunk') {
          sampleRate = reply.sampleRate;
          const { pcm } = reply;
          onEvent({
            kind: 'chunk',
            chunk: {
              index: reply.index,
              pcm: pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer,
              sampleRate: reply.sampleRate,
              durationSec: reply.durationSec,
              textStart: reply.textStart,
              textEnd: reply.textEnd,
            },
          });
        }
      },
      signal,
    );
    return {
      voice: input.voice,
      model: KOKORO_MODEL_ID,
      sampleRate,
      durationSec: done.durationSec,
      chunks: done.chunks,
    };
  }

  async stop(): Promise<void> {
    this.clearIdle();
    this.failAll(new KokoroEngineError('cancelled', 'Narration stopped.'));
    this.discard();
  }
}
