import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

/**
 * A slim supervisor for the bundled `gezel-whisper-server`.
 *
 * It follows Gezel's whisper.cpp provider and native supervisor: one server
 * process per model, started lazily on a loopback port with exactly Gezel's
 * arguments, ready once `/health` answers, fed one self-contained take per
 * `/inference` request. What DocBlocks leaves out is everything that exists
 * for a long-running daemon — the cross-process memory ledger, orphan sweeps,
 * remote endpoints — because here the server's lifetime is a dictation session.
 */

export type WhisperFailure = 'engine-unavailable' | 'engine-failed' | 'timeout' | 'cancelled';

export class WhisperEngineError extends Error {
  constructor(
    readonly failure: WhisperFailure,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'WhisperEngineError';
  }
}

export interface WhisperTranscribeInput {
  readonly audio: ArrayBuffer;
  readonly prompt?: string;
  readonly language?: string;
}

export interface WhisperTranscript {
  readonly text: string;
  readonly language: string | null;
  readonly segments: readonly { start: number; end: number; text: string }[];
  readonly durationMs: number;
}

export interface WhisperEngineOptions {
  /** Absolute path to `gezel-whisper-server[.exe]`. Main-authoritative only. */
  readonly binary: string;
  /** Arguments placed before Gezel's; tests use this to run a fake server script. */
  readonly leadingArgs?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly spawnImpl?: typeof spawn;
  readonly fetchImpl?: typeof fetch;
  readonly pickPort?: () => Promise<number>;
  readonly readyTimeoutMs?: number;
  readonly healthIntervalMs?: number;
  readonly requestTimeoutMs?: number;
  readonly idleStopMs?: number;
  readonly now?: () => number;
}

/** whisper.cpp emits this sentinel for valid audio containing no speech. */
export function normalizeWhisperTranscript(value: string): string {
  const text = value.trim();
  return /^\[\s*BLANK_AUDIO\s*\]$/iu.test(text) ? '' : text;
}

/** Windows `STATUS_DLL_NOT_FOUND`, as Node reports the exit code. */
const STATUS_DLL_NOT_FOUND = new Set([0xc0000135, -1073741515]);
const STDERR_TAIL_BYTES = 64 * 1024;
const RESTART_WINDOW_MS = 60_000;
const MAX_STARTS_PER_WINDOW = 3;
const KILL_GRACE_MS = 3_000;

/** Bind 127.0.0.1:0, read the port, close. Gezel's `pickFreePort`. */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen({ port: 0, host: '127.0.0.1' }, () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close();
        reject(new Error('Could not determine the bound port.'));
      }
    });
  });
}

interface Running {
  readonly child: ChildProcess;
  readonly model: string;
  readonly baseUrl: string;
  readonly ready: Promise<void>;
  exited: boolean;
}

export class WhisperEngine {
  private readonly options: WhisperEngineOptions;
  private running: Running | null = null;
  private starts: number[] = [];
  private stderr = '';
  private inFlight = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: WhisperEngineOptions) {
    this.options = options;
  }

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** The last output of the server, for diagnostics. */
  get diagnostics(): string {
    return this.stderr;
  }

  /** Start (or reuse) a ready server for `model`. */
  async prepare(model: string, signal?: AbortSignal): Promise<void> {
    // A start in progress counts as use, so the idle timer can never stop a
    // server that is still loading its model.
    this.inFlight += 1;
    this.clearIdle();
    try {
      if (this.running && !this.running.exited && this.running.model === model) {
        await this.wait(this.running.ready, signal);
        return;
      }
      if (this.running) await this.stop();
      const running = await this.start(model);
      await this.wait(running.ready, signal);
    } finally {
      this.inFlight -= 1;
      this.armIdle();
    }
  }

  private wait(ready: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!signal) return ready;
    if (signal.aborted) return Promise.reject(cancelled());
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(cancelled());
      signal.addEventListener('abort', onAbort, { once: true });
      ready.then(
        () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  private async start(model: string): Promise<Running> {
    const now = this.now;
    this.starts = this.starts.filter((at) => now - at < RESTART_WINDOW_MS);
    if (this.starts.length >= MAX_STARTS_PER_WINDOW) {
      throw new WhisperEngineError(
        'engine-failed',
        'The dictation engine keeps stopping. Try again in a minute.',
        this.stderr.slice(-2_000),
      );
    }
    this.starts.push(now);
    this.stderr = '';
    // A fresh port every start: the loopback server has no authentication,
    // so a stale port must never be reused by something else's listener.
    const port = await (this.options.pickPort ?? pickFreePort)();
    const args = [
      ...(this.options.leadingArgs ?? []),
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--model',
      model,
    ];
    const child = (this.options.spawnImpl ?? spawn)(this.options.binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: this.options.env ?? process.env,
    });
    const collect = (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    let exitFailure: ((error: WhisperEngineError) => void) | null = null;
    const exited = new Promise<never>((_, reject) => {
      exitFailure = reject;
    });
    // Unhandled until a caller is waiting on readiness.
    exited.catch(() => undefined);
    const running: Running = {
      child,
      model,
      baseUrl: `http://127.0.0.1:${port}`,
      ready: Promise.resolve(),
      exited: false,
    };
    child.once('error', (error: NodeJS.ErrnoException) => {
      running.exited = true;
      exitFailure?.(
        new WhisperEngineError(
          'engine-unavailable',
          'The dictation engine could not start.',
          `${error.code ?? ''} ${error.message}`.trim(),
        ),
      );
    });
    child.once('exit', (code, signal) => {
      running.exited = true;
      if (this.running === running) this.running = null;
      exitFailure?.(exitError(code, signal, this.stderr));
    });
    const ready = Promise.race([this.waitForHealth(running), exited]);
    (running as { ready: Promise<void> }).ready = ready;
    ready.catch(() => {
      if (!running.exited) child.kill('SIGKILL');
    });
    this.running = running;
    return running;
  }

  private async waitForHealth(running: Running): Promise<void> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const deadline = this.now + (this.options.readyTimeoutMs ?? 120_000);
    const interval = this.options.healthIntervalMs ?? 500;
    while (!running.exited) {
      const probe = deadlineSignal(Math.max(interval * 4, 1_000));
      try {
        const response = await fetchImpl(`${running.baseUrl}/health`, { signal: probe.signal });
        if (response.ok) return;
      } catch {
        // Not listening yet.
      } finally {
        probe.clear();
      }
      if (this.now >= deadline) {
        throw new WhisperEngineError(
          'timeout',
          'The dictation engine took too long to load its model.',
          this.stderr.slice(-2_000),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    // The exit handler rejects the race with the real reason.
    await new Promise(() => undefined);
  }

  async transcribe(
    model: string,
    input: WhisperTranscribeInput,
    signal?: AbortSignal,
  ): Promise<WhisperTranscript> {
    await this.prepare(model, signal);
    const running = this.running;
    if (!running) throw new WhisperEngineError('engine-failed', 'The dictation engine stopped.');
    this.inFlight += 1;
    this.clearIdle();
    const started = this.now;
    const timeoutMs = this.options.requestTimeoutMs ?? 300_000;
    const timeout = deadlineSignal(timeoutMs, signal);
    try {
      const form = multipartBody(input);
      let response: Response;
      try {
        response = await (this.options.fetchImpl ?? fetch)(`${running.baseUrl}/inference`, {
          method: 'POST',
          headers: { 'content-type': `multipart/form-data; boundary=${form.boundary}` },
          // The view spans its whole buffer, so the buffer is the exact body.
          body: form.body.buffer as ArrayBuffer,
          signal: timeout.signal,
        });
      } catch (error) {
        if (signal?.aborted) throw cancelled();
        if (timeout.expired()) {
          throw new WhisperEngineError('timeout', 'The dictation engine did not respond in time.');
        }
        // The connection failed, so the server is dead or wedged. Make sure the
        // next request starts a fresh one instead of reusing this process.
        await this.discard(running);
        throw new WhisperEngineError(
          'engine-failed',
          'The dictation engine stopped while transcribing.',
          `${error instanceof Error ? error.message : String(error)}\n${this.stderr.slice(-1_000)}`,
        );
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new WhisperEngineError(
          'engine-failed',
          'The dictation engine could not transcribe that audio.',
          `${response.status} ${body.slice(0, 300)}`,
        );
      }
      const payload = (await response.json()) as {
        text?: unknown;
        language?: unknown;
        segments?: unknown;
      };
      const segments = Array.isArray(payload.segments)
        ? payload.segments
            .filter(
              (s): s is { start: number; end: number; text: string } =>
                typeof s === 'object' &&
                s !== null &&
                typeof (s as { start?: unknown }).start === 'number' &&
                typeof (s as { end?: unknown }).end === 'number' &&
                typeof (s as { text?: unknown }).text === 'string',
            )
            .map((s) => ({ start: s.start, end: s.end, text: s.text.trim() }))
        : [];
      return {
        text: normalizeWhisperTranscript(typeof payload.text === 'string' ? payload.text : ''),
        language: typeof payload.language === 'string' ? payload.language : null,
        segments,
        durationMs: Math.max(0, this.now - started),
      };
    } finally {
      timeout.clear();
      this.inFlight -= 1;
      this.armIdle();
    }
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private armIdle(): void {
    this.clearIdle();
    if (this.inFlight > 0 || !this.running) return;
    this.idleTimer = setTimeout(
      () => {
        if (this.inFlight === 0) void this.stop();
      },
      this.options.idleStopMs ?? 10 * 60_000,
    );
    this.idleTimer.unref?.();
  }

  /** Wait briefly for a failed server to exit, then kill and forget it. */
  private async discard(running: Running): Promise<void> {
    if (!running.exited) {
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => {
          running.child.kill('SIGKILL');
          resolve();
        }, 1_000);
        running.child.once('exit', () => {
          clearTimeout(force);
          resolve();
        });
      });
    }
    if (this.running === running) this.running = null;
  }

  /** SIGTERM, then SIGKILL after a grace period. */
  async stop(): Promise<void> {
    this.clearIdle();
    const running = this.running;
    this.running = null;
    if (!running || running.exited) return;
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => running.child.kill('SIGKILL'), KILL_GRACE_MS);
      running.child.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
      running.child.kill('SIGTERM');
    });
  }
}

/**
 * The `/inference` form, built by hand. Global `FormData` and `Blob` belong to
 * whichever fetch realm is installed, and a mismatch serializes the form as the
 * literal text "[object FormData]" — Gezel hit exactly that. Bytes are
 * unambiguous everywhere.
 */
export function multipartBody(input: WhisperTranscribeInput): {
  boundary: string;
  body: Uint8Array;
} {
  const boundary = `----docblocks-${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const field = (name: string, value: string) =>
    parts.push(
      encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  parts.push(
    encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
    ),
    new Uint8Array(input.audio),
    encoder.encode('\r\n'),
  );
  field('response_format', 'json');
  if (input.language) field('language', input.language);
  if (input.prompt) field('prompt', input.prompt.replace(/\r?\n/gu, ' '));
  parts.push(encoder.encode(`--${boundary}--\r\n`));
  const body = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.byteLength;
  }
  return { boundary, body };
}

/**
 * An abort signal that fires after `ms` (or when `parent` aborts), with a timer
 * the caller clears. `AbortSignal.timeout` would leave the timer to the
 * environment, and some (test DOMs among them) keep it referenced for its full
 * duration after the request is long done.
 */
function deadlineSignal(
  ms: number,
  parent?: AbortSignal,
): { signal: AbortSignal; expired(): boolean; clear(): void } {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, ms);
  const onParentAbort = () => controller.abort();
  parent?.addEventListener('abort', onParentAbort, { once: true });
  if (parent?.aborted) controller.abort();
  return {
    signal: controller.signal,
    expired: () => expired,
    clear: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}

function cancelled(): WhisperEngineError {
  return new WhisperEngineError('cancelled', 'Dictation was cancelled.');
}

function exitError(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): WhisperEngineError {
  const tail = stderr.slice(-2_000);
  if (code !== null && STATUS_DLL_NOT_FOUND.has(code)) {
    return new WhisperEngineError(
      'engine-unavailable',
      'The dictation engine needs the Microsoft Visual C++ Redistributable. Reinstall DocBlocks or install it from Microsoft.',
      tail,
    );
  }
  return new WhisperEngineError(
    'engine-failed',
    'The dictation engine stopped unexpectedly.',
    `${signal ? `signal ${signal}` : `exit ${String(code)}`}\n${tail}`,
  );
}
