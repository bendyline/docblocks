/**
 * The Gezel implementation of the `AiConnector` seam.
 *
 * Gezel is an optional companion, reached two ways:
 *
 * 1. **The person's own Gezel.** DocBlocks discovers it through its per-user
 *    runtime files and asks for an inference-only (`openai`) grant.
 * 2. **A Gezel DocBlocks hosts itself** — a private daemon under
 *    `~/.gezel/apps/docblocks/`, started from a runtime DocBlocks can reach
 *    (see `gezel-host-runtime.ts`). It borrows the models already installed in
 *    the person's Gezel folder, read-only, and never downloads weights.
 *
 * The second is used whenever the first cannot serve: Gezel is not installed
 * or not running, or it will not connect DocBlocks. The person opted into AI
 * inside DocBlocks, which is the consent this fallback rests on; a Gezel that
 * is alive but failing is still reported rather than papered over.
 *
 * The SDK ships ESM only and this main bundle is CJS, so it is reached through
 * a dynamic `import()` that tsup leaves in place for the external specifier.
 * Loading it lazily also keeps it entirely out of a session whose user never
 * turns AI on.
 */

import type {
  ChatCompletionChunk,
  ChatStream,
  GezelApp,
  LocalAuthorizedConnection,
} from '@bendyline/gezel-app-sdk';
import type { EnsureModelEngine, Gezel } from '@bendyline/gezel-app-sdk/host';
import type { AiErrorCode, AiProgress } from '@bendyline/docblocks/host';

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

type GezelSdkModule = typeof import('@bendyline/gezel-app-sdk');
type GezelHostSdkModule = typeof import('@bendyline/gezel-app-sdk/host');

/** What Gezel lists under Settings → Connected Apps. */
export const GEZEL_APP_ID = 'docblocks';
export const GEZEL_APP_NAME = 'DocBlocks';
/**
 * Inference only. DocBlocks supplies its own documents and prompts, so it has
 * no use for Gezel's projects, sessions, or tools, and asks for none of them.
 */
export const GEZEL_SCOPES: readonly string[] = ['openai'];

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
  /**
   * An explicit daemon address and transport instead of runtime discovery.
   * Tests use it to run the real SDK against a fake daemon.
   */
  readonly endpoint?: { readonly baseUrl: string; readonly fetch: typeof fetch };
  /** Alternate Gezel home for discovery, and the one a hosted daemon borrows models from. */
  readonly home?: string;
  /** A Gezel this app can run itself, or null when this build cannot host. */
  readonly hostRuntime?: () => Promise<GezelHostRuntime | null>;
  /** Where a hosted daemon keeps its state; the SDK's `apps/docblocks` home by default. */
  readonly hostHome?: string;
}

function loadGezelSdk(): Promise<GezelSdkModule> {
  return import('@bendyline/gezel-app-sdk');
}

function loadGezelHostSdk(): Promise<GezelHostSdkModule> {
  return import('@bendyline/gezel-app-sdk/host');
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function toProviderChunk(chunk: ChatCompletionChunk): ProviderChatChunk {
  const choice = chunk.choices[0];
  const reason: string | null = choice?.finish_reason ?? null;
  const promptTokens = nonNegativeInteger(chunk.usage?.prompt_tokens);
  const completionTokens = nonNegativeInteger(chunk.usage?.completion_tokens);
  return {
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
  const stream = await app.chat(
    {
      model: request.model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      stream: true,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
    },
    { signal },
  );
  return adaptStream(stream);
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
  readonly mode = 'hosted' as const;

  constructor(
    private readonly gezel: Gezel,
    readonly version: string | null,
  ) {}

  async listModels(): Promise<readonly ProviderModelEntry[]> {
    const listing = await this.gezel.openai.models();
    return listing.data.filter((entry) => hostedModelParts(entry.id) !== null);
  }

  /**
   * Provision the engine for a model the person already has. `ensureModel`
   * would also download missing weights; that is never what DocBlocks asked
   * for, so the first sign of a weights download ends the attempt.
   */
  async prepare(modelId: string, onProgress: (progress: AiProgress) => void): Promise<void> {
    const parts = hostedModelParts(modelId);
    if (!parts) return;
    const abort = new AbortController();
    let wouldDownload = false;
    try {
      await this.gezel.ensureModel({
        model: parts.catalogId,
        engine: parts.engine,
        signal: abort.signal,
        onEvent: (event) => {
          if (
            (event.phase === 'weights' && (event.bytesWritten ?? 0) > 0) ||
            event.phase === 'bundle'
          ) {
            wouldDownload = true;
            abort.abort();
            return;
          }
          if (event.phase === 'engine') {
            onProgress({ phase: 'engine', message: event.message, percent: event.percent ?? null });
          }
        },
      });
    } catch (error) {
      if (wouldDownload) {
        throw new AiHostError(
          'model-unavailable',
          `${parts.catalogId} is not installed in your Gezel folder, and DocBlocks does not download models.`,
        );
      }
      throw error;
    }
  }

  streamChat(
    request: ProviderChatRequest,
    signal: AbortSignal,
  ): Promise<AsyncIterable<ProviderChatChunk>> {
    return streamFrom(this.gezel.openai, request, signal);
  }

  /** A private daemon holds no grant to withdraw. */
  async revoke(): Promise<void> {}

  /** Stops a daemon this app started; only releases one a sibling started. */
  close(): Promise<void> {
    return this.gezel.close();
  }
}

export class GezelConnector implements AiConnector {
  readonly providerName = 'Gezel';
  private readonly credentials: AiCredentialStore;
  private readonly loadSdk: () => Promise<GezelSdkModule>;
  private readonly loadHostSdk: () => Promise<GezelHostSdkModule>;
  private readonly endpoint: GezelConnectorOptions['endpoint'];
  private readonly home: string | undefined;
  private readonly hostRuntime: () => Promise<GezelHostRuntime | null>;
  private readonly hostHome: string | undefined;
  private sdk: Promise<GezelSdkModule> | null = null;
  private hostSdk: Promise<GezelHostSdkModule> | null = null;

  constructor(options: GezelConnectorOptions) {
    this.credentials = options.credentials;
    this.loadSdk = options.loadSdk ?? loadGezelSdk;
    this.loadHostSdk = options.loadHostSdk ?? loadGezelHostSdk;
    this.endpoint = options.endpoint;
    this.home = options.home;
    this.hostRuntime = options.hostRuntime ?? (() => Promise.resolve(null));
    this.hostHome = options.hostHome;
  }

  async detect(): Promise<AiDetection> {
    const canHost = (await this.hostRuntime().catch(() => null)) !== null;
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
    try {
      return await this.connectInstalled(options);
    } catch (error) {
      if (!runtime || !HOST_FALLBACK_CODES.has(toAiError(error).code)) throw error;
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

  private async connectHosted(runtime: GezelHostRuntime): Promise<AiProviderConnection> {
    const hostSdk = await this.hostModule();
    try {
      const gezel = await hostSdk.connectOrHost({
        appId: GEZEL_APP_ID,
        appName: GEZEL_APP_NAME,
        scopes: [...GEZEL_SCOPES],
        // The person's own Gezel was just tried; this call only hosts.
        adoptUserDaemon: false,
        host: {
          // A child under a real Node: the daemon's native modules would need
          // an Electron-ABI rebuild to load in this process.
          mode: 'child',
          nodePath: runtime.nodePath,
          daemonEntry: runtime.daemonEntry,
          // Engines shipped with DocBlocks; without them the daemon downloads
          // the one it pins on first use.
          ...(runtime.nativeBinDir ? { nativeBinDir: runtime.nativeBinDir } : {}),
          startTimeoutMs: HOST_START_TIMEOUT_MS,
          ...(this.hostHome ? { home: this.hostHome } : {}),
          ...(this.home ? { readOnlyModelHomes: [this.home] } : {}),
        },
      });
      return new HostedGezelConnection(gezel, runtime.version);
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
}
