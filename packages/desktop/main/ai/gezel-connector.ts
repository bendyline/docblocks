/**
 * The Gezel implementation of the `AiConnector` seam.
 *
 * Gezel is an optional companion, reached two ways:
 *
 * 1. **The person's own Gezel.** DocBlocks discovers it through its per-user
 *    runtime files and asks for inference (`openai`) and scoped `knowledge` access.
 * 2. **A Gezel DocBlocks hosts itself** — a private service under
 *    `~/.gezel/apps/docblocks/`, normally started in the Electron main process
 *    through the SDK's in-process host. It borrows the models already
 *    installed in the person's Gezel folder, read-only.
 *
 * The second is used whenever the first cannot serve: Gezel is not installed
 * or not running, or it will not connect DocBlocks. The person opted into AI
 * inside DocBlocks, which is the consent this fallback rests on; a Gezel that
 * is alive but failing is still reported rather than papered over.
 *
 * The SDK ships ESM only and this main bundle is CJS, so it is reached through
 * a dynamic `import()` that tsup leaves in place for the external specifier.
 * Loading it lazily keeps it out until Settings asks whether Gezel is installed
 * or the user turns AI on.
 */

import type {
  ChatCompletionChunk,
  ChatStream,
  GezelApp,
  LocalAuthorizedConnection,
} from '@bendyline/gezel-app-sdk';
import type {
  EnsureModelEngine,
  Gezel,
  HostOptions,
  HostServiceModule,
} from '@bendyline/gezel-app-sdk/host';
import type { AiErrorCode, AiProgress } from '@bendyline/docblocks/host';
import { parseAiChatProgress } from '@bendyline/docblocks/host';

import { AiHostError, toAiError } from './ai-errors.js';
import type {
  AiConnectOptions,
  AiConnector,
  AiDetection,
  AiProviderConnection,
  ProviderChatChunk,
  ProviderChatRequest,
} from './ai-service.js';
import type { ProviderModelEntry } from './ai-models.js';
import type { GezelHostRuntime } from './gezel-host-runtime.js';
import type { GezelNativeHost } from './gezel-native-host.js';
import { clearGezelEngineOverrides } from './gezel-native-host.js';
import { verifyMasNativePayload } from './gezel-mas-native.js';
import { APPLE_MODEL_ID, appleModelEntry } from './gezel-apple-model.js';
import {
  gezelKnowledgeState,
  updateGezelKnowledge,
  withGezelKnowledge,
} from './gezel-knowledge.js';
import type { AiKnowledgeAction } from '@bendyline/docblocks/host';

type GezelSdkModule = typeof import('@bendyline/gezel-app-sdk');
type GezelHostSdkModule = typeof import('@bendyline/gezel-app-sdk/host');
type GezelServiceModule = HostServiceModule &
  Pick<typeof import('@bendyline/gezel-service'), 'reuseVerifiedElectronNativeBinaries'> & {
    /** New SDKs repeat verification through this optional service hook. */
    verifyNativeBinaries?: typeof import('@bendyline/gezel-service').reuseVerifiedElectronNativeBinaries;
  };

/** What Gezel lists under Settings → Connected Apps. */
export const GEZEL_APP_ID = 'docblocks';
export const GEZEL_APP_NAME = 'DocBlocks';
/**
 * Inference and reference catalogs. The knowledge scope allows catalog
 * downloads/removal and retrieval, without granting project or session access.
 */
export const GEZEL_SCOPES: readonly string[] = ['openai', 'knowledge'];

/**
 * Long enough for someone to switch to Gezel, read the request, and type the
 * code; short enough that an abandoned request does not linger all afternoon.
 */
const APPROVAL_TIMEOUT_SEC = 300;

/** A cold first start of a hosted daemon does more than a warm restart. */
const HOST_START_TIMEOUT_MS = 120_000;

/**
 * Why the person's own Gezel did not serve, in the terms that make hosting the
 * right answer: absent, or unwilling to connect DocBlocks. Anything else — an
 * unknown failure from a Gezel that is running — is surfaced as it is.
 */
const HOST_FALLBACK_CODES: ReadonlySet<AiErrorCode> = new Set([
  'provider-unavailable',
  'approval-denied',
  'approval-timeout',
  'approval-expired',
  'approval-required',
  'already-connected',
  'inference-disabled',
]);

/**
 * On-device engines Gezel installs and runs itself. A hosted daemon offers
 * only these: its private home also lists a seeded crew of personas and any
 * cloud CLIs on PATH, and neither is what "a model in my Gezel folder" means.
 */
const HOSTED_ENGINES: ReadonlySet<EnsureModelEngine> = new Set(['llama-cpp', 'mlx', 'ds4']);

export interface AiCredentialStore {
  load(): Promise<string | null>;
  save(token: string): Promise<void>;
  delete(): Promise<void>;
}

export interface GezelConnectorOptions {
  readonly credentials: AiCredentialStore;
  readonly loadSdk?: () => Promise<GezelSdkModule>;
  readonly loadHostSdk?: () => Promise<GezelHostSdkModule>;
  readonly loadService?: () => Promise<GezelServiceModule>;
  /**
   * An explicit daemon address and transport instead of runtime discovery.
   * Tests use it to run the real SDK against a fake daemon.
   */
  readonly endpoint?: { readonly baseUrl: string; readonly fetch: typeof fetch };
  /** Alternate Gezel home for discovery, and the one a hosted daemon borrows models from. */
  readonly home?: string;
  /** A Gezel this app can run itself, or null when this build cannot host. */
  readonly hostRuntime?: () => Promise<GezelHostRuntime | null>;
  /** Host through the SDK's in-process service integration. */
  readonly hostInProcess?: boolean;
  /** Verified bundled engines and the distribution's executable-download policy. */
  readonly hostNative?: GezelNativeHost;
  /** Where a hosted daemon keeps its state; the SDK's `apps/docblocks` home by default. */
  readonly hostHome?: string;
  /** False inside MAS: discovery and borrowing external models are unavailable. */
  readonly standalone?: boolean;
  readonly appleModel?: () => Promise<ProviderModelEntry>;
}

function loadGezelSdk(): Promise<GezelSdkModule> {
  return import('@bendyline/gezel-app-sdk');
}

function loadGezelHostSdk(): Promise<GezelHostSdkModule> {
  return import('@bendyline/gezel-app-sdk/host');
}

function loadGezelService(): Promise<GezelServiceModule> {
  return import('@bendyline/gezel-service');
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function downloadPercent(completed: number | undefined, total: number | undefined): number | null {
  if (
    completed === undefined ||
    total === undefined ||
    !Number.isFinite(completed) ||
    !Number.isFinite(total) ||
    total <= 0
  ) {
    return null;
  }
  return Math.min(100, Math.max(0, (completed / total) * 100));
}

function toProviderChunk(chunk: ChatCompletionChunk): ProviderChatChunk {
  // SDK 1.1.3 preserves additive chunk fields. Validate the extension until
  // its typed SDK release is pinned, and tolerate providers without it.
  const progress = parseAiChatProgress(
    (chunk as ChatCompletionChunk & { gezel_progress?: unknown }).gezel_progress,
  );
  const choice = chunk.choices[0];
  const reason: string | null = choice?.finish_reason ?? null;
  const promptTokens = nonNegativeInteger(chunk.usage?.prompt_tokens);
  const completionTokens = nonNegativeInteger(chunk.usage?.completion_tokens);
  return {
    ...(progress ? { progress } : {}),
    text: typeof choice?.delta?.content === 'string' ? choice.delta.content : '',
    finishReason: reason === 'length' ? 'length' : reason === null ? null : 'stop',
    model: typeof chunk.model === 'string' && chunk.model ? chunk.model : null,
    usage:
      promptTokens !== null && completionTokens !== null
        ? { promptTokens, completionTokens }
        : null,
  };
}

async function* adaptStream(stream: ChatStream): AsyncGenerator<ProviderChatChunk> {
  for await (const chunk of stream) yield toProviderChunk(chunk);
}

async function streamFrom(
  app: GezelApp,
  request: ProviderChatRequest,
  signal: AbortSignal,
): Promise<AsyncIterable<ProviderChatChunk>> {
  const messages = await withGezelKnowledge(
    app,
    request.messages,
    signal,
    request.contextWindow,
    request.maxTokens,
  );
  // Omission alone would restore Gezel's shorter catalog output default.
  // For local writing, allow the model's full reported context capacity;
  // reasoning and visible output share this allowance. Remote providers own
  // their output limits, which can be smaller than their context windows.
  const localEngine = /^(?:mlx|llama-cpp|ollama|ds4):/u.test(request.model);
  const maxTokens =
    request.maxTokens ??
    (request.purpose === 'write' && localEngine ? request.contextWindow : undefined);
  const body = {
    model: request.model,
    messages: messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    stream: true as const,
    stream_options: { include_usage: true, include_progress: true },
    // Writing uses Gezel's model defaults: rewrite A/Bs did not justify
    // forcing reasoning off. Other tasks retain their existing latency/token
    // budgets pending their own evals.
    // The draft receives content only; reasoning stays inside Gezel.
    // SDK 1.1.3 sends this untyped field verbatim, hence the variable.
    ...(request.purpose === 'write' ? {} : { reasoning_effort: 'none' }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(maxTokens == null ? {} : { max_tokens: maxTokens }),
  };
  const stream = await app.chat(body, { signal });
  return adaptStream(stream);
}

/**
 * Bridge until the gezel-service pin falls back on its own: service 1.2.3
 * defers memory admission to an installed Gezel of another version, and an
 * installed Gezel too old to coordinate refuses every launch with this
 * sentence. DocBlocks' private engine then admits through its own ledger,
 * which still checks the RAM the OS reports free, and retries once. The
 * person never hears about the version mismatch. Delete with that pin bump.
 */
const OUTDATED_BROKER_REFUSAL = 'needs an update before isolated local engines can share memory';

function isOutdatedBrokerRefusal(error: unknown): boolean {
  return error instanceof Error && error.message.includes(OUTDATED_BROKER_REFUSAL);
}

/** The private engine runs in this process, so it reads this at its next launch. */
function admitLocally(): void {
  process.env.GEZEL_NATIVE_CAPACITY_AUTHORITY = 'local';
}

/**
 * Gezel opens a stream with an empty chunk before the engine launches, so the
 * refusal can arrive after the stream has started. Until the first text it is
 * still invisible: restart once, admitted locally.
 */
async function* restartingOnRefusal(
  stream: AsyncIterable<ProviderChatChunk>,
  restart: () => Promise<AsyncIterable<ProviderChatChunk>>,
  signal: AbortSignal,
): AsyncGenerator<ProviderChatChunk> {
  let wrote = false;
  try {
    for await (const chunk of stream) {
      if (chunk.text) wrote = true;
      yield chunk;
    }
    return;
  } catch (error) {
    if (wrote || signal.aborted || !isOutdatedBrokerRefusal(error)) throw error;
    admitLocally();
  }
  yield* await restart();
}

/** `llama-cpp:qwen3.8-27b-q4` → the engine and the catalog id it names. */
function hostedModelParts(id: string): { engine: EnsureModelEngine; catalogId: string } | null {
  const separator = id.indexOf(':');
  if (separator <= 0) return null;
  const engine = id.slice(0, separator) as EnsureModelEngine;
  const catalogId = id.slice(separator + 1);
  return HOSTED_ENGINES.has(engine) && catalogId ? { engine, catalogId } : null;
}

/** A connection to the person's own Gezel. */
class InstalledGezelConnection implements AiProviderConnection {
  knowledgeState(signal: AbortSignal): Promise<unknown> {
    return gezelKnowledgeState(this.app, signal);
  }
  updateKnowledge(action: AiKnowledgeAction, signal: AbortSignal): Promise<void> {
    return updateGezelKnowledge(this.app, action, signal);
  }
  readonly mode: AiProviderConnection['mode'];

  constructor(
    private readonly app: GezelApp,
    authorization: LocalAuthorizedConnection,
    private readonly credentials: AiCredentialStore,
  ) {
    // This path never asks the SDK to spawn a daemon, so the connection is to
    // a Gezel the person installed; 'spawned' is mapped for completeness.
    this.mode = authorization.daemon.mode === 'spawned' ? 'hosted' : 'installed';
  }

  async listModels(): Promise<readonly ProviderModelEntry[]> {
    const listing = await this.app.models();
    return listing.data;
  }

  async installModel(
    modelId: string,
    signal: AbortSignal,
    onProgress: (progress: AiProgress) => void,
  ): Promise<void> {
    const result = await this.app.ensureModel({ model: modelId }, { signal });
    if (result.status === 'ready' || !result.job_id) {
      onProgress({ phase: 'ready', message: 'Model is ready.', percent: 100 });
      return;
    }
    onProgress({ phase: 'weights', message: `Downloading ${modelId}…`, percent: null });
    for await (const event of this.app.streamEnsureEvents(result.job_id, { signal })) {
      if (event.type === 'progress') {
        onProgress({
          phase: 'weights',
          message: `Downloading ${modelId}…`,
          percent: downloadPercent(event.bytesWritten, event.totalBytes),
        });
      } else if (event.type === 'verifying') {
        onProgress({ phase: 'verifying', message: 'Verifying the model…', percent: null });
      } else if (event.type === 'extracting-metadata') {
        onProgress({ phase: 'metadata', message: 'Reading model metadata…', percent: null });
      } else if (event.type === 'retrying') {
        onProgress({
          phase: 'retrying',
          message: `Retrying the download (${event.attempt}/${event.maxAttempts})…`,
          percent: null,
        });
      } else if (event.type === 'error') {
        throw new AiHostError(
          'model-download-failed',
          'Gezel could not download the model.',
          event.error,
        );
      } else if (event.type === 'done') {
        onProgress({ phase: 'ready', message: 'Model is ready.', percent: 100 });
      }
    }
  }

  streamChat(
    request: ProviderChatRequest,
    signal: AbortSignal,
  ): Promise<AsyncIterable<ProviderChatChunk>> {
    return streamFrom(this.app, request, signal);
  }

  async revoke(): Promise<void> {
    try {
      await this.app.revokeMyToken(GEZEL_APP_ID);
    } finally {
      await this.credentials.delete();
    }
  }

  close(): Promise<void> {
    return this.app.close();
  }
}

/** A private daemon DocBlocks started, or one a sibling DocBlocks started. */
class HostedGezelConnection implements AiProviderConnection {
  knowledgeState(signal: AbortSignal): Promise<unknown> {
    return gezelKnowledgeState(this.gezel.openai, signal);
  }
  updateKnowledge(action: AiKnowledgeAction, signal: AbortSignal): Promise<void> {
    return updateGezelKnowledge(this.gezel.openai, action, signal);
  }
  readonly mode = 'hosted' as const;
  private readonly probeLifetime = new AbortController();
  private appleProbe: Promise<ProviderModelEntry> | null = null;

  constructor(
    private readonly gezel: Gezel,
    readonly version: string | null,
    private readonly nativeAppleModel?: (signal: AbortSignal) => Promise<ProviderModelEntry>,
    private readonly store = false,
    private readonly macAppStore = false,
  ) {}

  private probeApple(): Promise<ProviderModelEntry> | undefined {
    if (!this.nativeAppleModel) return undefined;
    this.probeLifetime.signal.throwIfAborted();
    this.appleProbe ??= this.nativeAppleModel(this.probeLifetime.signal).finally(() => {
      this.appleProbe = null;
    });
    return this.appleProbe;
  }

  private requireSupportedEngine(modelId: string): void {
    if (this.macAppStore && hostedModelParts(modelId)?.engine === 'ds4') {
      throw new AiHostError(
        'model-unavailable',
        'This build supports Apple Intelligence and llama.cpp models.',
      );
    }
    if (this.store && hostedModelParts(modelId)?.engine === 'mlx') {
      throw new AiHostError(
        'model-unavailable',
        'MLX needs a bundled Python runtime for this build. Choose Apple Intelligence or a llama.cpp model.',
      );
    }
  }

  async listModels(): Promise<readonly ProviderModelEntry[]> {
    const listing = await this.gezel.openai.models();
    const entries = listing.data.filter((entry) => {
      const parts = hostedModelParts(entry.id);
      return (
        parts !== null &&
        (!this.store || parts.engine === 'llama-cpp' || parts.engine === 'ds4') &&
        (!this.macAppStore || parts.engine === 'llama-cpp')
      );
    });
    // The released service routes Apple inference, but its /v1/models does
    // not yet enumerate the system provider. Probe the verified helper.
    const apple = await this.probeApple();
    return apple ? [apple, ...entries] : entries;
  }

  /**
   * Provision the engine for a model the person already has. `ensureModel`
   * would also download missing weights; that is never what DocBlocks asked
   * for, so the first sign of a weights download ends the attempt.
   */
  async prepare(modelId: string, onProgress: (progress: AiProgress) => void): Promise<void> {
    this.requireSupportedEngine(modelId);
    const parts = hostedModelParts(modelId);
    if (!parts) return;
    try {
      await this.gezel.ensureModel({
        model: parts.catalogId,
        engine: parts.engine,
        allowWeightDownload: false,
        onEvent: (event) => {
          if (event.phase === 'engine') {
            onProgress({ phase: 'engine', message: event.message, percent: event.percent ?? null });
          }
        },
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: unknown }).code === 'model_download_required'
      ) {
        throw new AiHostError(
          'model-unavailable',
          `${parts.catalogId} is not installed. Use Add model in Settings to download it.`,
        );
      }
      throw error;
    }
  }

  async installModel(
    modelId: string,
    signal: AbortSignal,
    onProgress: (progress: AiProgress) => void,
  ): Promise<void> {
    this.requireSupportedEngine(modelId);
    const parts = hostedModelParts(modelId);
    if (!parts) {
      throw new AiHostError('model-unavailable', 'That model cannot run in DocBlocks.');
    }
    await this.gezel.ensureModel({
      model: parts.catalogId,
      engine: parts.engine,
      signal,
      onEvent: (event) => {
        if (event.phase === 'ready') {
          onProgress({ phase: 'ready', message: 'Model is ready.', percent: 100 });
          return;
        }
        const completed =
          event.phase === 'bundle'
            ? event.bytesCompleted
            : event.phase === 'weights'
              ? event.bytesWritten
              : undefined;
        const total =
          event.phase === 'bundle'
            ? event.bytesTotal
            : event.phase === 'weights'
              ? event.totalBytes
              : undefined;
        onProgress({
          phase: event.phase,
          message: event.message,
          percent:
            ('percent' in event ? (event.percent ?? null) : null) ??
            downloadPercent(completed, total),
        });
      },
    });
  }

  async streamChat(
    request: ProviderChatRequest,
    signal: AbortSignal,
  ): Promise<AsyncIterable<ProviderChatChunk>> {
    signal.throwIfAborted();
    if (request.model === APPLE_MODEL_ID) {
      const model = await this.probeApple();
      if (model?.availability !== 'available')
        throw new AiHostError(
          'model-unavailable',
          model?.unavailable_reason ?? 'Apple Intelligence is unavailable.',
        );
    }
    this.requireSupportedEngine(request.model);
    signal.throwIfAborted();
    const start = () => streamFrom(this.gezel.openai, request, signal);
    if (process.env.GEZEL_NATIVE_CAPACITY_AUTHORITY) return start();
    let stream: AsyncIterable<ProviderChatChunk>;
    try {
      stream = await start();
    } catch (error) {
      if (signal.aborted || !isOutdatedBrokerRefusal(error)) throw error;
      admitLocally();
      return start();
    }
    return restartingOnRefusal(stream, start, signal);
  }

  /** A private daemon holds no grant to withdraw. */
  async revoke(): Promise<void> {}

  /** Stops a daemon this app started; only releases one a sibling started. */
  close(): Promise<void> {
    this.probeLifetime.abort();
    return this.gezel.close();
  }
}

export class GezelConnector implements AiConnector {
  readonly providerName = 'Gezel';
  private readonly credentials: AiCredentialStore;
  private readonly loadSdk: () => Promise<GezelSdkModule>;
  private readonly loadHostSdk: () => Promise<GezelHostSdkModule>;
  private readonly loadService: () => Promise<GezelServiceModule>;
  private readonly endpoint: GezelConnectorOptions['endpoint'];
  private readonly home: string | undefined;
  private readonly hostRuntime: () => Promise<GezelHostRuntime | null>;
  private readonly hostInProcess: boolean;
  private readonly hostHome: string | undefined;
  private sdk: Promise<GezelSdkModule> | null = null;
  private hostSdk: Promise<GezelHostSdkModule> | null = null;
  private service: Promise<GezelServiceModule> | null = null;
  private readonly hostNative: GezelNativeHost | undefined;
  private readonly standalone: boolean;
  private readonly appleModel: GezelConnectorOptions['appleModel'];

  constructor(options: GezelConnectorOptions) {
    this.credentials = options.credentials;
    this.loadSdk = options.loadSdk ?? loadGezelSdk;
    this.loadHostSdk = options.loadHostSdk ?? loadGezelHostSdk;
    this.loadService = options.loadService ?? loadGezelService;
    this.endpoint = options.endpoint;
    this.home = options.home;
    this.hostRuntime = options.hostRuntime ?? (() => Promise.resolve(null));
    this.hostInProcess = (options.hostInProcess ?? false) && options.hostNative?.canHost !== false;
    this.hostNative = options.hostNative;
    this.hostHome = options.hostHome;
    this.standalone = options.standalone ?? true;
    this.appleModel = options.appleModel;
  }

  async detect(): Promise<AiDetection> {
    const canHost = this.hostInProcess || (await this.hostRuntime().catch(() => null)) !== null;
    if (!this.standalone) return { installed: false, running: false, version: null, canHost };
    // An explicit endpoint is a configured daemon: it is either answering the
    // connection that follows or it is not, and that attempt says which.
    if (this.endpoint) return { installed: true, running: true, version: null, canHost };
    const sdk = await this.module();
    const result = await sdk.detectGezel(this.home ? { home: this.home } : undefined);
    return {
      installed: result.installed,
      running: result.running,
      version: result.version ?? null,
      canHost,
    };
  }

  async connect(options: AiConnectOptions): Promise<AiProviderConnection> {
    const runtime = await this.hostRuntime().catch(() => null);
    if (!this.standalone) return this.connectHosted(runtime);
    try {
      return await this.connectInstalled(options);
    } catch (error) {
      if ((!this.hostInProcess && !runtime) || !HOST_FALLBACK_CODES.has(toAiError(error).code)) {
        throw error;
      }
    }
    return this.connectHosted(runtime);
  }

  forget(): Promise<void> {
    return this.credentials.delete();
  }

  private async connectInstalled(options: AiConnectOptions): Promise<AiProviderConnection> {
    const sdk = await this.module();
    const credentials = this.credentials;
    const { app, authorization } = await sdk.connectLocal({
      appId: GEZEL_APP_ID,
      appName: GEZEL_APP_NAME,
      scopes: [...GEZEL_SCOPES],
      // DocBlocks is a first-party client: ask for the typed code even though
      // an inference-only grant would accept a click. It is also what makes a
      // silent reconnect safe — without a code handler the SDK refuses to
      // register a new grant, so a stale token can never raise a prompt.
      requireVerificationCode: true,
      approvalTimeoutSec: APPROVAL_TIMEOUT_SEC,
      tokenStorage: {
        load: () => credentials.load(),
        save: (_appId, token) => credentials.save(token),
        delete: () => credentials.delete(),
      },
      ...(options.interactive && options.onVerificationCode
        ? { onVerificationCode: options.onVerificationCode }
        : {}),
      ...(this.endpoint
        ? { baseUrl: this.endpoint.baseUrl, fetch: this.endpoint.fetch }
        : this.home
          ? { daemon: { home: this.home } }
          : {}),
    });
    return new InstalledGezelConnection(app, authorization, credentials);
  }

  private async verifyNativePayload(
    nativeBinDir: string,
    verifier: GezelServiceModule,
    allowStandaloneMacPayload: boolean,
  ): ReturnType<GezelServiceModule['reuseVerifiedElectronNativeBinaries']> {
    // Gezel's source verifier stamps this variable; the SDK owns its lifetime.
    const previous = process.env.GEZEL_NATIVE_BIN_DIR;
    try {
      if (this.hostNative?.macAppStore) {
        await verifyMasNativePayload(nativeBinDir);
        return { reused: true, reason: 'Verified MAS native app seal.', nativeBinDir };
      }
      return await verifier.reuseVerifiedElectronNativeBinaries({
        candidates: [nativeBinDir],
        allowStandaloneMacPayload,
      });
    } finally {
      if (previous === undefined) delete process.env.GEZEL_NATIVE_BIN_DIR;
      else process.env.GEZEL_NATIVE_BIN_DIR = previous;
    }
  }

  private async connectHosted(runtime: GezelHostRuntime | null): Promise<AiProviderConnection> {
    const hostSdk = await this.hostModule();
    try {
      const serviceModule = this.hostInProcess ? await this.serviceModule() : null;
      const nativeBinDir = this.hostNative?.nativeBinDir ?? runtime?.nativeBinDir;
      const allowStandaloneMacPayload =
        this.hostNative?.allowStandaloneMacPayload ?? runtime?.source === 'development';
      if (nativeBinDir) {
        const verifier = serviceModule ?? (await this.serviceModule());
        const verified = await this.verifyNativePayload(
          nativeBinDir,
          verifier,
          allowStandaloneMacPayload,
        );
        if (!verified.reused) {
          throw new Error(`Bundled Gezel engines failed verification: ${verified.reason}`);
        }
      }
      const hostedService: GezelServiceModule | null = serviceModule
        ? {
            ...serviceModule,
            verifyNativeBinaries: async (input) => {
              if (
                !nativeBinDir ||
                input.candidates?.length !== 1 ||
                input.candidates[0] !== nativeBinDir
              )
                return {
                  reused: false,
                  reason: 'Only the configured bundled native payload may be verified.',
                };
              return this.verifyNativePayload(
                nativeBinDir,
                serviceModule,
                allowStandaloneMacPayload,
              );
            },
            startService: async (input) => {
              const restore =
                this.hostNative?.distributionProfile === 'store'
                  ? clearGezelEngineOverrides()
                  : () => undefined;
              const borrowed = process.env.GEZEL_READONLY_MODEL_HOMES;
              if (!this.standalone) delete process.env.GEZEL_READONLY_MODEL_HOMES;
              const restoreEnvironment = () => {
                restore();
                if (!this.standalone) {
                  if (borrowed === undefined) delete process.env.GEZEL_READONLY_MODEL_HOMES;
                  else process.env.GEZEL_READONLY_MODEL_HOMES = borrowed;
                }
              };
              try {
                const running = await serviceModule.startService(input);
                return {
                  ...running,
                  stop: async () => {
                    try {
                      await running.stop();
                    } finally {
                      restoreEnvironment();
                    }
                  },
                };
              } catch (error) {
                restoreEnvironment();
                throw error;
              }
            },
          }
        : null;
      const inProcessHost: HostOptions | null = this.hostInProcess
        ? {
            mode: 'in-process',
            inferenceOnly: true,
            serviceModule: hostedService ?? undefined,
            ...(nativeBinDir ? { nativeBinDir } : {}),
            ...(this.hostNative
              ? { distributionProfile: this.hostNative.distributionProfile }
              : {}),
            ...(this.hostHome ? { home: this.hostHome } : {}),
            ...(!this.standalone
              ? { readOnlyModelHomes: [] }
              : this.home
                ? { readOnlyModelHomes: [this.home] }
                : {}),
          }
        : null;
      const gezel = await hostSdk.connectOrHost({
        appId: GEZEL_APP_ID,
        appName: GEZEL_APP_NAME,
        scopes: [...GEZEL_SCOPES],
        // The person's own Gezel was just tried; this call only hosts.
        adoptUserDaemon: false,
        host: inProcessHost
          ? inProcessHost
          : {
              mode: 'child',
              nodePath: runtime?.nodePath,
              daemonEntry: runtime?.daemonEntry,
              // Engines shipped with DocBlocks; without them the daemon
              // downloads the one it pins on first use.
              ...(nativeBinDir || runtime?.nativeBinDir
                ? { nativeBinDir: nativeBinDir ?? runtime?.nativeBinDir }
                : {}),
              ...(this.hostNative
                ? { distributionProfile: this.hostNative.distributionProfile }
                : {}),
              startTimeoutMs: HOST_START_TIMEOUT_MS,
              ...(this.hostHome ? { home: this.hostHome } : {}),
              ...(this.home ? { readOnlyModelHomes: [this.home] } : {}),
            },
      });
      const appleNativeBinDir = this.hostNative?.nativeBinDir;
      const apple =
        this.appleModel ??
        (process.platform === 'darwin' && process.arch === 'arm64' && appleNativeBinDir
          ? (signal: AbortSignal) => appleModelEntry(appleNativeBinDir, signal)
          : undefined);
      return new HostedGezelConnection(
        gezel,
        runtime?.version ?? null,
        apple,
        this.hostNative?.distributionProfile === 'store',
        this.hostNative?.macAppStore === true,
      );
    } catch (error) {
      throw new AiHostError(
        'runtime-missing',
        'DocBlocks could not start its built-in Gezel.',
        error instanceof Error ? error.message : undefined,
      );
    }
  }

  private module(): Promise<GezelSdkModule> {
    // Retry after a failed load rather than caching the rejection forever.
    this.sdk ??= this.loadSdk().catch((error: unknown) => {
      this.sdk = null;
      throw error;
    });
    return this.sdk;
  }

  private hostModule(): Promise<GezelHostSdkModule> {
    this.hostSdk ??= this.loadHostSdk().catch((error: unknown) => {
      this.hostSdk = null;
      throw error;
    });
    return this.hostSdk;
  }

  private serviceModule(): Promise<GezelServiceModule> {
    this.service ??= this.loadService().catch((error: unknown) => {
      this.service = null;
      throw error;
    });
    return this.service;
  }
}
