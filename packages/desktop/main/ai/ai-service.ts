/**
 * The main-process state machine behind `DocBlocksHostAiAPI`.
 *
 * It owns one provider connection, the user's AI preferences, and every
 * in-flight completion. It knows nothing about Electron or IPC — `ipc-ai.ts`
 * adapts it to the renderer — and nothing about a particular provider beyond
 * the `AiConnector` seam, which is what lets the unit tests drive every state
 * without a daemon.
 *
 * Three rules shape it:
 *
 * - **Opt-out starts nothing.** Settings may detect whether the person's Gezel
 *   is installed so connection UI appears only when relevant. While `enabled`
 *   is false no provider is connected, contacted for inference, or hosted.
 * - **Only a gesture can prompt.** `start()` and re-enabling first reuse a
 *   stored credential, then fall back to DocBlocks' private hosted Gezel. The
 *   consent handshake for the person's standalone Gezel runs only from
 *   `connect()`, which the renderer calls from a click.
 * - **Every chat ends exactly once.** A stream terminates with one `done` or
 *   one `error` event, whether it finished, hit a budget, was cancelled, or
 *   lost its provider.
 */

import {
  AI_WIRE_LIMITS,
  HOST_WIRE_LIMITS,
  isBoundedString,
  parseAiKnowledgeState,
} from '@bendyline/docblocks/host';
import type { AiKnowledgeState, AiKnowledgeAction } from '@bendyline/docblocks/host';
import type {
  AiChatEvent,
  AiChatMessage,
  AiChatRequest,
  AiConnectionStep,
  AiError,
  AiModelDownloadInfo,
  AiModelInfo,
  AiModelInstallEvent,
  AiPreferences,
  AiPreferencesPatch,
  AiProgress,
  AiProviderInfo,
  AiResult,
  AiStatus,
  AiUnavailableReason,
} from '@bendyline/docblocks/host';

import { AiHostError, aiError, toAiError } from './ai-errors.js';
import {
  selectModel,
  toAiModelDownloadList,
  toAiModelList,
  type ProviderModelEntry,
} from './ai-models.js';

export const DEFAULT_AI_PREFERENCES: AiPreferences = Object.freeze({
  enabled: false,
  model: null,
  reviewMode: 'explicit',
});

export interface AiDetection {
  /** The person's own provider install. */
  readonly installed: boolean;
  readonly running: boolean;
  readonly version: string | null;
  /**
   * Whether this app can run the provider itself when the person's own is
   * absent or will not connect. When true, a missing provider is not a
   * reason to stop.
   */
  readonly canHost: boolean;
}

export interface AiConnectOptions {
  /**
   * False for a silent reconnect: reuse a stored credential or fail with
   * `approval-required`, and never start a consent handshake.
   */
  readonly interactive: boolean;
  onVerificationCode?(code: string): void;
}

export interface ProviderChatRequest {
  readonly contextWindow?: number | null;
  readonly model: string;
  readonly messages: readonly AiChatMessage[];
  readonly temperature?: number;
  readonly maxTokens?: number;
}

export interface ProviderChatChunk {
  readonly text: string;
  readonly finishReason: 'stop' | 'length' | null;
  readonly model: string | null;
  readonly usage: { readonly promptTokens: number; readonly completionTokens: number } | null;
}

export interface AiProviderConnection {
  knowledgeState?(signal: AbortSignal): Promise<unknown>;
  updateKnowledge?(action: AiKnowledgeAction, signal: AbortSignal): Promise<void>;
  readonly mode: AiProviderInfo['mode'];
  /** The version of the provider actually serving, when it differs from detection. */
  readonly version?: string | null;
  listModels(): Promise<readonly ProviderModelEntry[]>;
  /**
   * Make a listed model runnable — an engine download, never a weights
   * download — reporting progress. Absent when the provider prepares models
   * itself.
   */
  prepare?(modelId: string, onProgress: (progress: AiProgress) => void): Promise<void>;
  /** Download model weights after an explicit user gesture. */
  installModel?(
    modelId: string,
    signal: AbortSignal,
    onProgress: (progress: AiProgress) => void,
  ): Promise<void>;
  streamChat(
    request: ProviderChatRequest,
    signal: AbortSignal,
  ): Promise<AsyncIterable<ProviderChatChunk>>;
  /** Withdraw this app's grant at the provider and forget the stored credential. */
  revoke(): Promise<void>;
  close(): Promise<void>;
}

export interface AiConnector {
  readonly providerName: string;
  detect(): Promise<AiDetection>;
  connect(options: AiConnectOptions): Promise<AiProviderConnection>;
  /** Forget any stored credential without contacting the provider. */
  forget(): Promise<void>;
}

export interface AiPreferenceStore {
  read(): Promise<AiPreferences>;
  write(preferences: AiPreferences): Promise<void>;
}

export interface AiServiceOptions {
  readonly connector: AiConnector;
  readonly preferences: AiPreferenceStore;
  /** Concurrent completions across every renderer. */
  readonly maxConcurrentChats?: number;
  /** Abort a stream that stalls this long between chunks once text is flowing. */
  readonly streamIdleTimeoutMs?: number;
  /**
   * Abort a stream that has produced no text after this long. Gezel owns the
   * real time-to-first-token deadline, sized to the prompt, and reports it as
   * an error; this only catches a connection that hangs without saying so.
   */
  readonly firstTextTimeoutMs?: number;
  /** A status read re-detects an absent provider at most this often. */
  readonly redetectIntervalMs?: number;
  readonly now?: () => number;
}

export type AiChatEmitter = (event: AiChatEvent) => void;
export type AiModelInstallEmitter = (event: AiModelInstallEvent) => void;

type ChatEnding = 'caller' | 'timeout' | 'teardown' | 'length';

interface ActiveChat {
  readonly controller: AbortController;
  ending: ChatEnding | null;
}

interface ConnectionAttempt {
  readonly interactive: boolean;
  readonly promise: Promise<AiResult<AiStatus>>;
}

const DEFAULT_MAX_CONCURRENT_CHATS = 4;
// Between chunks once text flows: a stall this long means the stream is dead.
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 180_000;
// Before the first text a local model may load, prefill a long document, and
// think — none of which reaches DocBlocks as chunks. A 180s limit here was a
// second, shorter deadline under Gezel's own and cut off a model mid-thought.
const DEFAULT_FIRST_TEXT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_REDETECT_INTERVAL_MS = 15_000;
// Across all windows. State reads coalesce per window, so only a runaway
// renderer reaches this.
const MAX_KNOWLEDGE_REQUESTS = 16;

function ok<T>(value: T): AiResult<T> {
  return { ok: true, value };
}

function fail<T>(error: AiError): AiResult<T> {
  return { ok: false, error };
}

function unavailable(reason: AiUnavailableReason): AiStatus {
  return { kind: 'unavailable', reason };
}

function connecting(step: AiConnectionStep, verificationCode: string | null = null): AiStatus {
  return { kind: 'connecting', step, verificationCode, progress: null };
}

function boundedVersion(version: string | null): string | null {
  if (version === null) return null;
  return isBoundedString(version, HOST_WIRE_LIMITS.labelCharacters) ? version : null;
}

function boundedProgress(progress: AiProgress): AiProgress {
  const clean = (text: string, limit: number) => text.replaceAll('\0', '').slice(0, limit);
  const percent =
    progress.percent === null || !Number.isFinite(progress.percent)
      ? null
      : Math.min(100, Math.max(0, progress.percent));
  return {
    phase: clean(progress.phase, AI_WIRE_LIMITS.progressPhaseCharacters) || 'preparing',
    message: clean(progress.message, HOST_WIRE_LIMITS.messageCharacters),
    percent,
  };
}

function boundedCode(code: string): string | null {
  return isBoundedString(code, AI_WIRE_LIMITS.verificationCodeCharacters, 1) ? code : null;
}

/** Split text into wire-sized deltas without separating a surrogate pair. */
function emitDeltas(text: string, emit: AiChatEmitter): void {
  const limit = AI_WIRE_LIMITS.deltaCharacters;
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(offset + limit, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    emit({ kind: 'delta', text: text.slice(offset, end) });
    offset = end;
  }
}

export class AiService {
  private readonly connector: AiConnector;
  private readonly store: AiPreferenceStore;
  private readonly maxConcurrentChats: number;
  private readonly streamIdleTimeoutMs: number;
  private readonly firstTextTimeoutMs: number;
  private readonly redetectIntervalMs: number;
  private readonly now: () => number;

  private status: AiStatus = unavailable('opt-out');
  private readonly listeners = new Set<(status: AiStatus) => void>();
  private preferences: AiPreferences = DEFAULT_AI_PREFERENCES;
  private preferencesLoaded: Promise<void> | null = null;
  private preferenceUpdates: Promise<void> = Promise.resolve();
  private connection: AiProviderConnection | null = null;
  private providerVersion: string | null = null;
  private models: readonly AiModelInfo[] = [];
  private attempt: ConnectionAttempt | null = null;
  private detection: Promise<AiDetection> | null = null;
  private lastAttemptAt = Number.NEGATIVE_INFINITY;
  /** Bumped whenever the connection is torn down; stale async work checks it. */
  private epoch = 0;
  private readonly chats = new Map<string, ActiveChat>();
  private readonly modelInstalls = new Map<string, AbortController>();
  /** In-flight catalog requests per window, so closing a window cancels its own. */
  private readonly knowledgeRequests = new Map<string, Set<AbortController>>();
  /**
   * One catalog-state read per window. A StrictMode remount, a progress poll,
   * and a Refresh click all ask at once; they share the answer, never a
   * rejection.
   */
  private readonly knowledgeStateReads = new Map<string, Promise<AiResult<AiKnowledgeState>>>();
  private disposed = false;

  constructor(options: AiServiceOptions) {
    this.connector = options.connector;
    this.store = options.preferences;
    this.maxConcurrentChats = options.maxConcurrentChats ?? DEFAULT_MAX_CONCURRENT_CHATS;
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    this.firstTextTimeoutMs = options.firstTextTimeoutMs ?? DEFAULT_FIRST_TEXT_TIMEOUT_MS;
    this.redetectIntervalMs = options.redetectIntervalMs ?? DEFAULT_REDETECT_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  /** Load preferences and, when AI is on, reconnect silently. */
  async start(): Promise<void> {
    await this.loadPreferences();
    if (this.preferences.enabled && !this.disposed) void this.beginAttempt(false);
  }

  /**
   * The current status. A provider that was absent at the last look is looked
   * for again, silently and at most every `redetectIntervalMs`, so starting
   * Gezel after DocBlocks is noticed the next time the renderer asks.
   */
  async getStatus(): Promise<AiStatus> {
    await this.loadPreferences();
    const absent =
      this.status.kind === 'unavailable' &&
      (this.status.reason === 'not-running' ||
        this.status.reason === 'not-installed' ||
        this.status.reason === 'disconnected');
    if (
      this.preferences.enabled &&
      absent &&
      !this.attempt &&
      this.now() - this.lastAttemptAt >= this.redetectIntervalMs
    ) {
      void this.beginAttempt(false);
    }
    return this.status;
  }

  onStatus(listener: (status: AiStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async getPreferences(): Promise<AiPreferences> {
    await this.loadPreferences();
    return this.preferences;
  }

  /** Detect only the person's installation; hosted capability is intentionally irrelevant here. */
  async providerInstalled(): Promise<boolean> {
    return (await this.detectProvider()).installed;
  }

  setPreferences(patch: AiPreferencesPatch): Promise<AiPreferences> {
    const captured = { ...patch };
    const update = this.preferenceUpdates.then(() => this.applyPreferences(captured));
    this.preferenceUpdates = update.then(
      () => undefined,
      () => undefined,
    );
    return update;
  }

  private async applyPreferences(patch: AiPreferencesPatch): Promise<AiPreferences> {
    await this.loadPreferences();
    if (this.disposed) throw new Error('The AI service has been disposed.');
    const previous = this.preferences;
    const next: AiPreferences = { ...previous, ...patch };
    await this.store.write(next);
    this.preferences = next;
    if (this.disposed) return next;

    if (previous.enabled && !next.enabled) {
      await this.teardown(false);
      this.setStatus(unavailable('opt-out'));
    } else if (!previous.enabled && next.enabled) {
      if (!this.attempt) void this.beginAttempt(false);
    } else if (
      next.enabled &&
      !this.connection &&
      !this.attempt &&
      (this.status.kind === 'error' || this.status.kind === 'unavailable')
    ) {
      // Writing the already-enabled preference is the retry affordance used by
      // Settings. It must remain silent: connecting the standalone Gezel is a
      // separate, optional gesture.
      void this.beginAttempt(false);
    } else if (this.status.kind === 'ready') {
      this.publishReady();
    }
    return next;
  }

  /** Detect, then run consent if needed. Call only from a user gesture. */
  async connect(): Promise<AiResult<AiStatus>> {
    await this.loadPreferences();
    if (!this.preferences.enabled) {
      return fail(aiError('provider-unavailable', 'Turn on AI features in Settings first.'));
    }
    if (this.connection && this.status.kind === 'ready') {
      if (this.connection.mode !== 'hosted') return ok(this.status);
      // The built-in provider is already useful. An explicit Connect click is
      // a request to replace it with the person's standalone Gezel.
      await this.teardown(false);
    }
    // A silent attempt may already be running. Let it finish: if it reconnected
    // with a stored credential there is nothing left to ask the user.
    while (this.attempt) {
      const current = this.attempt;
      const result = await current.promise;
      if (current.interactive) return result;
      if (result.ok && this.connection?.mode !== 'hosted') return result;
      if (result.ok) await this.teardown(false);
    }
    return this.beginAttempt(true);
  }

  /** Disconnect the standalone Gezel and fall back to DocBlocks' private host. */
  async disconnect(): Promise<AiResult<null>> {
    await this.loadPreferences();
    if (this.connection?.mode === 'hosted') return ok(null);
    const previousAttempt = this.attempt?.promise;
    await this.teardown(true);
    if (previousAttempt) await previousAttempt.catch(() => undefined);
    if (this.preferences.enabled && !this.disposed) {
      void this.beginAttempt(false);
    } else {
      this.setStatus(unavailable('opt-out'));
    }
    return ok(null);
  }

  cancelKnowledge(owner: string): void {
    for (const controller of this.knowledgeRequests.get(owner) ?? []) controller.abort();
  }

  knowledgeState(owner: string): Promise<AiResult<AiKnowledgeState>> {
    const pending = this.knowledgeStateReads.get(owner);
    if (pending) return pending;
    const read = this.withKnowledge(owner, async (connection, signal) => {
      if (!connection.knowledgeState)
        throw new AiHostError(
          'unsupported',
          'This AI provider does not support knowledge catalogs.',
        );
      const state = parseAiKnowledgeState(await connection.knowledgeState(signal));
      if (!state)
        throw new AiHostError('unknown', 'The AI provider returned invalid catalog information.');
      return state;
    }).finally(() => this.knowledgeStateReads.delete(owner));
    this.knowledgeStateReads.set(owner, read);
    return read;
  }

  async updateKnowledge(owner: string, action: AiKnowledgeAction): Promise<AiResult<null>> {
    return this.withKnowledge(owner, async (connection, signal) => {
      if (!connection.updateKnowledge)
        throw new AiHostError(
          'unsupported',
          'This AI provider does not support knowledge catalogs.',
        );
      await connection.updateKnowledge(action, signal);
      return null;
    });
  }

  private async withKnowledge<T>(
    owner: string,
    run: (connection: AiProviderConnection, signal: AbortSignal) => Promise<T>,
  ): Promise<AiResult<T>> {
    const connection = this.connection;
    if (!connection || !this.preferences.enabled || this.disposed)
      return fail(this.notConnectedError());
    let inFlight = 0;
    for (const owned of this.knowledgeRequests.values()) inFlight += owned.size;
    // A local bound, so it must not read as "Gezel is busy".
    if (inFlight >= MAX_KNOWLEDGE_REQUESTS) return fail(aiError('budget-exceeded'));
    const controller = new AbortController();
    const owned = this.knowledgeRequests.get(owner) ?? new Set<AbortController>();
    owned.add(controller);
    this.knowledgeRequests.set(owner, owned);
    const signal = controller.signal;
    const timer = setTimeout(
      () => controller.abort(new AiHostError('timeout', 'The catalog request timed out.')),
      30_000,
    );
    let onAbort: () => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const value = await Promise.race([run(connection, signal), aborted]);
      signal.throwIfAborted();
      if (this.connection !== connection)
        throw new AiHostError('cancelled', 'The AI connection changed.');
      return ok(value);
    } catch (error) {
      return fail(toAiError(error));
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      owned.delete(controller);
      if (owned.size === 0) this.knowledgeRequests.delete(owner);
    }
  }

  async listModels(): Promise<AiResult<readonly AiModelInfo[]>> {
    const connection = this.connection;
    if (!connection) return fail(this.notConnectedError());
    try {
      const models = toAiModelList(await connection.listModels());
      if (this.connection === connection) {
        this.models = models;
        this.publishReady();
      }
      return ok(models);
    } catch (error) {
      const failure = toAiError(error);
      this.handleProviderFailure(connection, failure);
      return fail(failure);
    }
  }

  async listAvailableModels(): Promise<AiResult<readonly AiModelDownloadInfo[]>> {
    const connection = this.connection;
    if (!connection) return fail(this.notConnectedError());
    if (!connection.installModel) {
      return fail(aiError('unsupported', 'This AI provider cannot download models.'));
    }
    try {
      return ok(toAiModelDownloadList(await connection.listModels()));
    } catch (error) {
      const failure = toAiError(error);
      this.handleProviderFailure(connection, failure);
      return fail(failure);
    }
  }

  /** Start one user-requested install, scoped by the IPC layer to its renderer. */
  startModelInstall(streamKey: string, modelId: string, emit: AiModelInstallEmitter): void {
    const connection = this.connection;
    if (!connection || this.status.kind !== 'ready') {
      emit({ kind: 'error', error: this.notConnectedError() });
      return;
    }
    if (!connection.installModel) {
      emit({
        kind: 'error',
        error: aiError('unsupported', 'This AI provider cannot download models.'),
      });
      return;
    }
    if (!isBoundedString(modelId, HOST_WIRE_LIMITS.identifierCharacters, 1)) {
      emit({ kind: 'error', error: aiError('model-unavailable', 'That model id is invalid.') });
      return;
    }
    if (this.modelInstalls.has(streamKey)) {
      emit({
        kind: 'error',
        error: aiError('unknown', 'That model download is already running.'),
      });
      return;
    }
    if (this.modelInstalls.size >= 2) {
      emit({
        kind: 'error',
        error: aiError('budget-exceeded', 'Two model downloads are already running.'),
      });
      return;
    }

    const controller = new AbortController();
    let ended = false;
    const emitEvent = (event: AiModelInstallEvent) => {
      if (ended) return;
      if (event.kind !== 'progress') ended = true;
      emit(event);
    };
    this.modelInstalls.set(streamKey, controller);
    void connection
      .installModel(modelId, controller.signal, (progress) => {
        if (!controller.signal.aborted) {
          emitEvent({ kind: 'progress', progress: boundedProgress(progress) });
        }
      })
      .then(async () => {
        if (controller.signal.aborted)
          throw new AiHostError('cancelled', 'The download was cancelled.');
        const entries = await connection.listModels();
        const models = toAiModelList(entries);
        const model = models.find((candidate) => candidate.id === modelId);
        if (!model) {
          throw new AiHostError(
            'model-download-failed',
            'The download finished, but the model is not available yet.',
          );
        }
        if (this.connection === connection) {
          this.models = models;
          this.publishReady();
        }
        emitEvent({ kind: 'done', model });
      })
      .catch((error: unknown) => {
        const failure = controller.signal.aborted ? aiError('cancelled') : toAiError(error);
        emitEvent({ kind: 'error', error: failure });
        this.handleProviderFailure(connection, failure);
      })
      .finally(() => {
        this.modelInstalls.delete(streamKey);
      });
  }

  cancelModelInstall(streamKey: string): void {
    this.modelInstalls.get(streamKey)?.abort();
  }

  /**
   * Start a streamed completion. Returns at once; `emit` receives deltas and
   * then exactly one terminal event. `streamKey` must be unique among live
   * streams — the IPC layer scopes it to the owning renderer.
   */
  startChat(streamKey: string, request: AiChatRequest, emit: AiChatEmitter): void {
    const connection = this.connection;
    if (!connection || this.status.kind !== 'ready') {
      emit({ kind: 'error', error: this.notConnectedError() });
      return;
    }
    if (this.chats.has(streamKey)) {
      emit({ kind: 'error', error: aiError('unknown', 'That request is already running.') });
      return;
    }
    if (this.chats.size >= this.maxConcurrentChats) {
      emit({ kind: 'error', error: aiError('budget-exceeded') });
      return;
    }
    const model = request.model ?? selectModel(this.models, this.preferences.model)?.id;
    if (!model) {
      emit({
        kind: 'error',
        error: aiError(
          'model-unavailable',
          'Gezel has no models available. Add one in Settings, then try again.',
        ),
      });
      return;
    }

    const chat: ActiveChat = { controller: new AbortController(), ending: null };
    this.chats.set(streamKey, chat);
    this.publishActivity();
    const providerRequest: ProviderChatRequest = {
      model,
      contextWindow: this.models.find((entry) => entry.id === model)?.contextWindow ?? null,
      messages: request.messages,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
    };
    void this.runChat(connection, chat, providerRequest, emit).finally(() => {
      this.chats.delete(streamKey);
      this.publishActivity();
    });
  }

  /** Stop a stream. It still ends with a `done` event carrying the partial text. */
  cancelChat(streamKey: string): void {
    const chat = this.chats.get(streamKey);
    if (!chat) return;
    chat.ending ??= 'caller';
    chat.controller.abort();
  }

  get activeChatCount(): number {
    return this.chats.size;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.teardown(false);
    this.listeners.clear();
  }

  // ── connection ──────────────────────────────────────────────────────

  private loadPreferences(): Promise<void> {
    this.preferencesLoaded ??= this.store.read().then(
      (preferences) => {
        this.preferences = preferences;
      },
      () => undefined,
    );
    return this.preferencesLoaded;
  }

  private beginAttempt(interactive: boolean): Promise<AiResult<AiStatus>> {
    this.lastAttemptAt = this.now();
    const promise = this.attemptConnection(interactive, this.epoch)
      .catch((error: unknown) => fail<AiStatus>(toAiError(error)))
      .finally(() => {
        if (this.attempt?.promise === promise) this.attempt = null;
      });
    this.attempt = { interactive, promise };
    return promise;
  }

  /** Share concurrent SDK discovery between Settings and a connection attempt. */
  private detectProvider(): Promise<AiDetection> {
    if (this.detection) return this.detection;
    const pending = this.connector.detect();
    this.detection = pending;
    const clear = () => {
      if (this.detection === pending) this.detection = null;
    };
    void pending.then(clear, clear);
    return pending;
  }

  private async attemptConnection(
    interactive: boolean,
    epoch: number,
  ): Promise<AiResult<AiStatus>> {
    const stale = () => this.disposed || epoch !== this.epoch;
    this.setStatus(connecting('detecting'));

    let detection: AiDetection;
    try {
      detection = await this.detectProvider();
    } catch (error) {
      return this.failAttempt(error, epoch);
    }
    if (stale()) return fail(aiError('cancelled'));
    // A provider this app can host itself makes the person's own install
    // optional; without one, their Gezel has to be there and running.
    if (!detection.installed && !detection.canHost) {
      this.setStatus(unavailable('not-installed'));
      return fail(aiError('provider-unavailable', 'Gezel is not installed on this computer.'));
    }
    if (!detection.running && !detection.canHost) {
      this.setStatus(unavailable('not-running'));
      return fail(aiError('provider-unavailable'));
    }
    this.providerVersion = boundedVersion(detection.version);

    let connection: AiProviderConnection;
    try {
      connection = await this.connector.connect({
        interactive,
        ...(interactive
          ? {
              onVerificationCode: (code: string) => {
                if (!stale()) this.setStatus(connecting('awaiting-approval', boundedCode(code)));
              },
            }
          : {}),
      });
    } catch (error) {
      return this.failAttempt(error, epoch);
    }
    if (stale()) {
      await connection.close().catch(() => undefined);
      return fail(aiError('cancelled'));
    }

    let models: AiModelInfo[] = [];
    try {
      models = toAiModelList(await connection.listModels());
    } catch (error) {
      const failure = toAiError(error);
      if (failure.code === 'approval-required' || failure.code === 'provider-unavailable') {
        await connection.close().catch(() => undefined);
        return this.failAttempt(error, epoch);
      }
      // Anything else leaves a working connection with an empty listing; the
      // next `models()` call tries again.
    }
    if (stale()) {
      await connection.close().catch(() => undefined);
      return fail(aiError('cancelled'));
    }

    // A hosted provider with no model is useful only when it can install one
    // after an explicit user gesture in Settings.
    if (connection.mode === 'hosted' && models.length === 0 && !connection.installModel) {
      await connection.close().catch(() => undefined);
      return this.failAttempt(
        new AiHostError(
          'model-unavailable',
          'No on-device model was found in your Gezel folder. Install one in Gezel, then try again.',
        ),
        epoch,
      );
    }

    // A hosted provider may still need an engine for the model it will run.
    // Do it now, with progress, so the first request is not a silent minute.
    const selected = selectModel(models, this.preferences.model);
    if (connection.prepare && selected) {
      this.setStatus({
        kind: 'connecting',
        step: 'preparing-model',
        verificationCode: null,
        progress: null,
      });
      try {
        await connection.prepare(selected.id, (progress) => {
          if (!stale()) {
            this.setStatus({
              kind: 'connecting',
              step: 'preparing-model',
              verificationCode: null,
              progress: boundedProgress(progress),
            });
          }
        });
      } catch (error) {
        await connection.close().catch(() => undefined);
        return this.failAttempt(error, epoch);
      }
      if (stale()) {
        await connection.close().catch(() => undefined);
        return fail(aiError('cancelled'));
      }
    }

    this.connection = connection;
    if (connection.version !== undefined) {
      this.providerVersion = boundedVersion(connection.version);
    }
    this.models = models;
    this.publishReady();
    return ok(this.status);
  }

  private failAttempt(error: unknown, epoch: number): AiResult<AiStatus> {
    const failure = toAiError(error);
    if (this.disposed || epoch !== this.epoch) return fail(failure);
    if (failure.code === 'provider-unavailable') {
      this.setStatus(unavailable('not-running'));
    } else if (failure.code === 'approval-required') {
      this.setStatus(unavailable('disconnected'));
    } else {
      this.setStatus({
        kind: 'error',
        error: failure,
        retryable: failure.code !== 'runtime-missing',
      });
    }
    return fail(failure);
  }

  private async teardown(revoke: boolean): Promise<void> {
    this.epoch += 1;
    for (const chat of this.chats.values()) {
      chat.ending ??= 'teardown';
      chat.controller.abort();
    }
    for (const install of this.modelInstalls.values()) install.abort();
    for (const owned of this.knowledgeRequests.values()) {
      for (const request of owned) request.abort();
    }
    const connection = this.connection;
    this.connection = null;
    this.models = [];
    if (connection) {
      if (revoke) await connection.revoke().catch(() => undefined);
      await connection.close().catch(() => undefined);
    } else if (revoke) {
      await this.connector.forget().catch(() => undefined);
    }
  }

  /** A provider call proved the connection is gone; reflect it once. */
  private handleProviderFailure(connection: AiProviderConnection, failure: AiError): void {
    if (this.connection !== connection) return;
    if (failure.code !== 'provider-unavailable' && failure.code !== 'approval-required') return;
    this.connection = null;
    this.models = [];
    this.epoch += 1;
    void connection.close().catch(() => undefined);
    this.setStatus(unavailable('disconnected'));
    // Losing the standalone app is not losing AI: reconnect silently, which
    // lets the connector reuse a grant or start the private host.
    if (this.preferences.enabled && !this.disposed && !this.attempt) {
      void this.beginAttempt(false);
    }
  }

  private notConnectedError(): AiError {
    return this.preferences.enabled
      ? aiError('provider-unavailable', 'AI is still getting ready. Try again in a moment.')
      : aiError('provider-unavailable', 'Turn on AI features in Settings first.');
  }

  // ── chat ────────────────────────────────────────────────────────────

  private async runChat(
    connection: AiProviderConnection,
    chat: ActiveChat,
    request: ProviderChatRequest,
    emit: AiChatEmitter,
  ): Promise<void> {
    let text = '';
    let finishReason: 'stop' | 'length' | 'cancelled' = 'stop';
    let usage: ProviderChatChunk['usage'] = null;
    let model = request.model;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(
        () => {
          chat.ending ??= 'timeout';
          chat.controller.abort();
        },
        text ? this.streamIdleTimeoutMs : this.firstTextTimeoutMs,
      );
      // A watchdog must not be the only thing keeping a process alive.
      idle.unref?.();
    };

    armIdle();
    try {
      const stream = await connection.streamChat(request, chat.controller.signal);
      for await (const chunk of stream) {
        if (chunk.model && isBoundedString(chunk.model, HOST_WIRE_LIMITS.identifierCharacters, 1)) {
          model = chunk.model;
        }
        if (chunk.usage) usage = chunk.usage;
        if (chunk.text) {
          const clean = chunk.text.replaceAll('\0', '');
          const room = AI_WIRE_LIMITS.completionCharacters - text.length;
          const piece = clean.slice(0, room);
          if (piece) {
            text += piece;
            emitDeltas(piece, emit);
          }
          if (clean.length > room) {
            chat.ending ??= 'length';
            break;
          }
        }
        if (chunk.finishReason === 'length') finishReason = 'length';
        if (chat.ending) break;
        // After the text is counted, so the first words switch to the stall limit.
        armIdle();
      }
      if (chat.ending === 'timeout') throw new AiHostError('timeout', 'Gezel stopped responding.');
      if (chat.ending === 'teardown') {
        throw new AiHostError('cancelled', 'The connection to Gezel was closed.');
      }
      if (chat.ending === 'caller') finishReason = 'cancelled';
      if (chat.ending === 'length') finishReason = 'length';
      emit({ kind: 'done', completion: { text, model, finishReason, usage } });
    } catch (error) {
      if (chat.ending === 'caller') {
        emit({ kind: 'done', completion: { text, model, finishReason: 'cancelled', usage } });
        return;
      }
      if (chat.ending === 'timeout') {
        emit({ kind: 'error', error: aiError('timeout') });
        return;
      }
      if (chat.ending === 'teardown') {
        emit({
          kind: 'error',
          error: aiError('cancelled', 'The connection to Gezel was closed.'),
        });
        return;
      }
      const failure = toAiError(error);
      // The renderer shows only the sentence; the provider's reason is for logs.
      console.warn(`[ai] request failed (${failure.code}): ${failure.detail ?? failure.message}`);
      emit({ kind: 'error', error: failure });
      this.handleProviderFailure(connection, failure);
    } finally {
      clearTimeout(idle);
      // Release the HTTP stream whatever ended it; aborting a finished request
      // is a no-op.
      chat.controller.abort();
    }
  }

  // ── status ──────────────────────────────────────────────────────────

  private publishReady(): void {
    if (!this.connection) return;
    this.setStatus({
      kind: 'ready',
      provider: {
        name: this.connector.providerName,
        version: this.providerVersion,
        mode: this.connection.mode,
      },
      model: selectModel(this.models, this.preferences.model),
      activeRequests: this.chats.size,
    });
  }

  private publishActivity(): void {
    if (this.status.kind === 'ready') this.publishReady();
  }

  private setStatus(next: AiStatus): void {
    if (JSON.stringify(next) === JSON.stringify(this.status)) return;
    this.status = next;
    for (const listener of [...this.listeners]) {
      try {
        listener(next);
      } catch {
        // A broken listener must not stop the others or the state machine.
      }
    }
  }
}
