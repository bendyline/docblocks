/** Gezel owns connection, model preparation, and engine lifecycle; DocBlocks owns its host policy. */
import path from 'node:path';
import type { ChatCompletionChunk, GezelApp } from '@bendyline/gezel-app-sdk';
import type {
  DesktopEmbeddingConnection,
  HostOptions,
  HostServiceModule,
  ModelProgress,
} from '@bendyline/gezel-app-sdk/host';
import type { AiProgress } from '@bendyline/docblocks/host';
import { parseAiChatProgress } from '@bendyline/docblocks/host';
import { AiHostError } from './ai-errors.js';
import type {
  AiConnectOptions,
  AiConnector,
  AiDetection,
  AiProviderConnection,
  ProviderChatChunk,
  ProviderChatRequest,
} from './ai-service.js';
import type { GezelNativeHost } from './gezel-native-host.js';
import { verifyMasNativePayload } from './gezel-mas-native.js';
import {
  gezelKnowledgeState,
  updateGezelKnowledge,
  withGezelKnowledge,
} from './gezel-knowledge.js';

type GezelSdkModule = typeof import('@bendyline/gezel-app-sdk');
type GezelHostSdkModule = typeof import('@bendyline/gezel-app-sdk/host');
export const GEZEL_APP_ID = 'docblocks';
export const GEZEL_APP_NAME = 'DocBlocks';
export const GEZEL_SCOPES: readonly string[] = ['openai', 'knowledge'];

export interface AiCredentialStore {
  load(): Promise<string | null>;
  save(token: string): Promise<void>;
  delete(): Promise<void>;
}
export interface GezelConnectorOptions {
  readonly credentials: AiCredentialStore;
  readonly loadSdk?: () => Promise<GezelSdkModule>;
  readonly loadHostSdk?: () => Promise<GezelHostSdkModule>;
  readonly loadService?: () => Promise<HostServiceModule>;
  readonly endpoint?: { readonly baseUrl: string; readonly fetch: typeof fetch };
  readonly home?: string;
  readonly hostInProcess?: boolean;
  readonly hostNative?: GezelNativeHost;
  readonly hostHome?: string;
  /** MAS cannot discover standalone Gezel or borrow its model homes. */
  readonly standalone?: boolean;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function toProviderChunk(chunk: ChatCompletionChunk): ProviderChatChunk {
  const progress = parseAiChatProgress(chunk.gezel_progress);
  const choice = chunk.choices[0];
  const reason = choice?.finish_reason ?? null;
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
function modelProgress(progress: ModelProgress): AiProgress {
  const { bytesWritten, totalBytes } = progress;
  const percent =
    progress.percent ??
    (bytesWritten !== undefined && totalBytes !== undefined && totalBytes > 0
      ? (bytesWritten / totalBytes) * 100
      : null);
  return { phase: progress.phase, message: progress.message, percent };
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
  // Preserve the evaluated writing policy until effective output budgets have their own A/B gate.
  const localEngine = /^(?:mlx|llama-cpp|ollama|ds4):/u.test(request.model);
  const maxTokens =
    request.maxTokens ??
    (request.purpose === 'write' && localEngine ? request.contextWindow : undefined);
  const stream = await app.chat(
    {
      model: request.model,
      messages,
      stream: true,
      stream_options: { include_usage: true, include_progress: true },
      ...(request.purpose === 'write' ? {} : { reasoning_effort: 'none' }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(maxTokens == null ? {} : { max_tokens: maxTokens }),
    },
    { signal },
  );
  return (async function* () {
    for await (const chunk of stream) yield toProviderChunk(chunk);
  })();
}

function adaptConnection(connection: DesktopEmbeddingConnection): AiProviderConnection {
  return {
    mode: connection.mode,
    listModels: () => connection.models.list(),
    knowledgeState: (signal) => gezelKnowledgeState(connection.app, signal),
    updateKnowledge: (action, signal) => updateGezelKnowledge(connection.app, action, signal),
    async prepare(model, onProgress) {
      await connection.models.prepare(model, {
        onProgress: (progress) => onProgress(modelProgress(progress)),
      });
    },
    async installModel(model, signal, onProgress) {
      await connection.models.prepare(model, {
        allowDownload: true,
        signal,
        onProgress: (progress) => onProgress(modelProgress(progress)),
      });
      onProgress({ phase: 'ready', message: 'Model is ready.', percent: 100 });
    },
    async streamChat(request, signal) {
      if (connection.mode === 'hosted') {
        const model = await connection.models.inspect(request.model, { signal });
        if (!model || model.availability !== 'available')
          throw new AiHostError(
            'model-unavailable',
            model?.unavailable_reason ?? 'That model is not available in DocBlocks.',
          );
      }
      return streamFrom(connection.app, request, signal);
    },
    revoke: () => connection.revoke(),
    close: () => connection.close(),
  };
}

export class GezelConnector implements AiConnector {
  readonly providerName = 'Gezel';
  private sdk: Promise<GezelSdkModule> | null = null;
  private hostSdk: Promise<GezelHostSdkModule> | null = null;
  private service: Promise<HostServiceModule> | null = null;
  constructor(private readonly options: GezelConnectorOptions) {}

  async detect(): Promise<AiDetection> {
    const canHost = this.canHost();
    if (this.options.standalone === false)
      return { installed: false, running: false, version: null, canHost };
    if (this.options.endpoint) return { installed: true, running: true, version: null, canHost };
    const result = await (
      await this.module()
    ).detectGezel(this.options.home ? { home: this.options.home } : undefined);
    return {
      installed: result.installed,
      running: result.running,
      version: result.version ?? null,
      canHost,
    };
  }

  async connect(options: AiConnectOptions): Promise<AiProviderConnection> {
    const sdk = await this.hostModule();
    if (typeof sdk.connectDesktopEmbedding !== 'function')
      throw new AiHostError(
        'runtime-missing',
        'This build needs the Gezel embedding SDK. Update DocBlocks and its Gezel runtime together.',
      );
    const { credentials, endpoint, home, hostNative } = this.options;
    const connection = await sdk.connectDesktopEmbedding(
      {
        appId: GEZEL_APP_ID,
        appName: GEZEL_APP_NAME,
        knowledge: true,
        approvalTimeoutSec: 300,
        hostWhenRefused: true,
        ...(this.options.standalone === false ? { adoptUserDaemon: false } : {}),
        tokenStorage: {
          load: () => credentials.load(),
          save: (_appId, token) => credentials.save(token),
          delete: () => credentials.delete(),
        },
        ...(options.onVerificationCode ? { onVerificationCode: options.onVerificationCode } : {}),
        ...(endpoint
          ? { baseUrl: endpoint.baseUrl, fetch: endpoint.fetch }
          : home
            ? { daemon: { home } }
            : {}),
        ...(this.canHost() ? { host: this.hostOptions() } : {}),
        ...(hostNative?.macAppStore ? { hostedEngines: ['llama-cpp'] } : {}),
      },
      { interactive: options.interactive },
    );
    return adaptConnection(connection);
  }

  forget(): Promise<void> {
    return this.options.credentials.delete();
  }
  private canHost(): boolean {
    return this.options.hostInProcess === true && this.options.hostNative?.canHost !== false;
  }

  private hostOptions(): HostOptions {
    const { home, hostHome, hostNative, standalone } = this.options;
    const nativeBinDir = hostNative?.nativeBinDir;
    return {
      ...(nativeBinDir ? { nativeBinDir } : {}),
      ...(hostNative ? { distributionProfile: hostNative.distributionProfile } : {}),
      ...(hostHome
        ? { home: hostHome }
        : home
          ? { home: path.join(home, 'apps', GEZEL_APP_ID) }
          : {}),
      ...(standalone === false
        ? { readOnlyModelHomes: [] }
        : home
          ? { readOnlyModelHomes: [home] }
          : {}),
      serviceModule: {
        startService: async (input) => (await this.serviceModule()).startService(input),
        verifyNativeBinaries: async (input) => {
          if (
            !nativeBinDir ||
            input.candidates.length !== 1 ||
            input.candidates[0] !== nativeBinDir
          )
            return {
              reused: false,
              reason: 'Only the configured bundled native payload may be verified.',
            };
          if (hostNative?.macAppStore) {
            await verifyMasNativePayload(nativeBinDir);
            return { reused: true, reason: 'Verified MAS native app seal.', nativeBinDir };
          }
          const verify = (await this.serviceModule()).verifyNativeBinaries;
          if (!verify)
            throw new AiHostError(
              'runtime-missing',
              'This Gezel service cannot verify bundled engines.',
            );
          return verify({
            ...input,
            allowStandaloneMacPayload: hostNative?.allowStandaloneMacPayload,
          });
        },
      },
    };
  }
  private module(): Promise<GezelSdkModule> {
    this.sdk ??= (this.options.loadSdk?.() ?? import('@bendyline/gezel-app-sdk')).catch(
      (error: unknown) => {
        this.sdk = null;
        throw error;
      },
    );
    return this.sdk;
  }
  private hostModule(): Promise<GezelHostSdkModule> {
    this.hostSdk ??= (
      this.options.loadHostSdk?.() ?? import('@bendyline/gezel-app-sdk/host')
    ).catch((error: unknown) => {
      this.hostSdk = null;
      throw error;
    });
    return this.hostSdk;
  }
  private serviceModule(): Promise<HostServiceModule> {
    this.service ??= (this.options.loadService?.() ?? import('@bendyline/gezel-service')).catch(
      (error: unknown) => {
        this.service = null;
        throw error;
      },
    );
    return this.service;
  }
}
