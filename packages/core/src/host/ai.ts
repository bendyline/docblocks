/**
 * The host-agnostic AI seam.
 *
 * Nothing here names a provider product. Model ids are opaque strings, the
 * vocabulary is "provider" and "connection", and the capability is described by
 * what it can do rather than by what is installed behind it. That is deliberate:
 * the desktop bridge, the VS Code bridge and any future mobile bridge all
 * satisfy this contract, and `packages/react` must never learn which one it is
 * talking to.
 *
 * Every operation that can fail for an expected reason returns `AiResult`
 * rather than rejecting. A provider that is not running, a user who declines
 * approval and a model that is still downloading are ordinary states of this
 * feature, not exceptions, and a renderer must be able to render them without a
 * try/catch around every call.
 */

/** An expected-failure envelope. Rejections stay reserved for genuine bugs. */
export type AiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AiError };

export type AiErrorCode =
  /** No provider is installed, running, or reachable. */
  | 'provider-unavailable'
  | 'approval-denied'
  | 'approval-timeout'
  | 'approval-expired'
  /** The stored credential no longer carries the scopes this operation needs. */
  | 'approval-required'
  /** The provider is reachable but has its connected-app surface switched off. */
  | 'inference-disabled'
  /** The provider believes this app already holds a credential we no longer have. */
  | 'already-connected'
  | 'model-unavailable'
  | 'model-download-failed'
  /** A hosted runtime was expected but is missing or unusable on this build. */
  | 'runtime-missing'
  | 'workspace-not-registered'
  /** The host does not implement this operation at all. */
  | 'unsupported'
  | 'budget-exceeded'
  | 'rate-limited'
  | 'timeout'
  | 'cancelled'
  | 'unknown';

export interface AiError {
  readonly code: AiErrorCode;
  /** Shown to the user. Never truncate a provider's own explanation into this. */
  readonly message: string;
  /** Optional diagnostic detail for logs; not for display. */
  readonly detail?: string;
}

/**
 * Why AI is not on offer.
 *
 * `opt-out` is first-class rather than an absence, because "the user has not
 * switched this on" must never be reported as a broken provider. A host may
 * still check whether its companion provider is installed so the settings UI
 * can explain the connection only when it is relevant; it must not connect or
 * start a hosted provider while this state holds.
 */
export type AiUnavailableReason =
  | 'opt-out'
  | 'platform-unsupported'
  | 'not-installed'
  | 'not-running'
  | 'disconnected';

export type AiConnectionStep =
  | 'detecting'
  | 'awaiting-approval'
  | 'preparing-model'
  | 'preparing-workspace';

export interface AiProgress {
  /** Short machine-ish label, e.g. `weights`. Bounded; not free prose. */
  readonly phase: string;
  readonly message: string;
  /** 0-100, or null when the work reports no measurable total. */
  readonly percent: number | null;
}

export interface AiProviderInfo {
  readonly name: string;
  readonly version: string | null;
  /** Whether the provider runs as a separate install or inside this app. */
  readonly mode: 'installed' | 'hosted' | 'remote';
}

export interface AiModelInfo {
  readonly id: string;
  readonly label: string;
  /** True when inference happens on this device. */
  readonly local: boolean;
  /** Token budget, when the provider reports one. Drives prompt budgeting. */
  readonly contextWindow: number | null;
  readonly isDefault: boolean;
  /** Omitted by hosts whose listing contains only ready models. */
  readonly availability?: 'available' | 'unavailable' | 'download-required' | 'downloading';
  /** Native readiness explanation, suitable for the model picker. */
  readonly unavailableReason?: string;
}

/** A provider-catalog model that can be added to this device. */
export interface AiModelDownloadInfo {
  readonly id: string;
  readonly label: string;
  readonly contextWindow: number | null;
  /** Expected weight download size, when the provider reports one. */
  readonly downloadBytes: number | null;
  readonly state: 'download-required' | 'downloading';
}

export type AiStatus =
  | { readonly kind: 'unavailable'; readonly reason: AiUnavailableReason }
  | {
      readonly kind: 'connecting';
      readonly step: AiConnectionStep;
      /**
       * A short challenge the user types into the provider to approve this app.
       * It is a one-time proof of presence, not a credential, which is why it
       * may cross to the renderer for display.
       */
      readonly verificationCode: string | null;
      readonly progress: AiProgress | null;
    }
  | {
      readonly kind: 'ready';
      readonly provider: AiProviderInfo;
      readonly model: AiModelInfo | null;
      readonly activeRequests: number;
    }
  | { readonly kind: 'error'; readonly error: AiError; readonly retryable: boolean };

export type AiReviewMode = 'off' | 'explicit' | 'implicit';

export interface AiPreferences {
  readonly enabled: boolean;
  /** Preferred model id, or null to take the provider's default. */
  readonly model: string | null;
  readonly reviewMode: AiReviewMode;
}

export type AiPreferencesPatch = Partial<AiPreferences>;

export interface AiChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/**
 * What the request is for.
 *
 * This exists so the host can apply different budgets to a person waiting on a
 * draft and a background review pass. It is never sent to the model.
 */
export type AiChatPurpose = 'write' | 'review' | 'chat';

export interface AiChatRequest {
  readonly messages: readonly AiChatMessage[];
  /** Opaque provider model id. Omitted means "the host's current choice". */
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly purpose: AiChatPurpose;
}

export interface AiChatCompletion {
  readonly text: string;
  readonly model: string;
  readonly finishReason: 'stop' | 'length' | 'cancelled';
  readonly usage: { readonly promptTokens: number; readonly completionTokens: number } | null;
}

export type AiChatEvent =
  | { readonly kind: 'delta'; readonly text: string }
  | { readonly kind: 'done'; readonly completion: AiChatCompletion }
  | { readonly kind: 'error'; readonly error: AiError };

export interface AiChatHandle {
  readonly done: Promise<AiResult<AiChatCompletion>>;
  cancel(): void;
}

/**
 * One explicitly requested model install.
 *
 * Cancelling stops this caller's progress stream. A provider-owned background
 * download may still finish and appear in the next model refresh.
 */
export interface AiModelInstallHandle {
  readonly done: Promise<AiResult<AiModelInfo>>;
  cancel(): void;
}

export type AiModelInstallEvent =
  | { readonly kind: 'progress'; readonly progress: AiProgress }
  | { readonly kind: 'done'; readonly model: AiModelInfo }
  | { readonly kind: 'error'; readonly error: AiError };

export interface AiEnsureWorkspaceHandle {
  readonly done: Promise<AiResult<{ readonly indexed: boolean }>>;
  cancel(): void;
}

export interface AiSearchQuery {
  readonly query: string;
  readonly mode: 'names' | 'full';
  readonly maxResults?: number;
}

export interface AiSearchHit {
  /** Canonical root-relative workspace path. Never an absolute filesystem path. */
  readonly path: string;
  readonly title: string | null;
  readonly snippet: string | null;
  readonly score: number;
}

export interface AiSearchResult {
  readonly hits: readonly AiSearchHit[];
  readonly truncated: boolean;
}

export interface AiImageRequest {
  readonly prompt: string;
  readonly width?: number;
  readonly height?: number;
}

export interface AiImageResult {
  readonly mimeType: 'image/png';
  readonly data: ArrayBuffer;
  readonly width: number;
  readonly height: number;
}

export interface AiTranscribeRequest {
  readonly audio: ArrayBuffer;
  readonly mimeType: string;
  readonly language?: string;
}

export interface AiTranscript {
  readonly text: string;
  readonly language: string | null;
}

export interface AiSynthesizeRequest {
  readonly text: string;
  readonly voice?: string;
}

export interface AiSpeechAudio {
  readonly mimeType: 'audio/wav';
  readonly data: ArrayBuffer;
}

/**
 * The AI namespace on `DocBlocksHostAPI`.
 *
 * The members below the core group are optional one by one rather than as a
 * block, because they fail independently: a paired-device mobile host could
 * plausibly transcribe from its own microphone while offering no image
 * generation and no workspace index. `deriveHostCapabilities` observes each,
 * so a host cannot claim an ability whose member is missing.
 *
 * A host that cannot do AI at all — an unsupported platform — omits this whole
 * namespace rather than exposing one that always fails.
 */
export interface DocBlocksHostAiAPI {
  /** Optional catalog browsing, downloads, and retrieval model setup. */
  readonly knowledge?: import('./ai-knowledge.js').AiKnowledgeAPI;
  /** Whether the host's user-installed companion provider is present. */
  providerInstalled(): Promise<boolean>;
  status(): Promise<AiStatus>;
  onStatus(listener: (status: AiStatus) => void): () => void;
  getPreferences(): Promise<AiPreferences>;
  setPreferences(patch: AiPreferencesPatch): Promise<AiPreferences>;
  /**
   * Run detection and approval. Called only from an explicit user gesture —
   * never at startup, where a silent reconnect is the host's own business.
   */
  connect(): Promise<AiResult<AiStatus>>;
  disconnect(): Promise<AiResult<null>>;
  models(): Promise<AiResult<readonly AiModelInfo[]>>;
  /** Catalog models this host can download. Optional for older providers. */
  availableModels?(): Promise<AiResult<readonly AiModelDownloadInfo[]>>;
  /** Start a model download from an explicit user gesture. */
  installModel?(modelId: string, onProgress?: (progress: AiProgress) => void): AiModelInstallHandle;
  /**
   * Start a streamed completion.
   *
   * The correlation id is minted by the bridge, not by the caller, so a
   * renderer cannot address another renderer's stream.
   */
  chat(request: AiChatRequest, onEvent: (event: AiChatEvent) => void): AiChatHandle;

  ensureWorkspace?(
    workspaceId: string,
    onProgress?: (progress: AiProgress) => void,
  ): AiEnsureWorkspaceHandle;
  search?(workspaceId: string, query: AiSearchQuery): Promise<AiResult<AiSearchResult>>;
  generateImage?(request: AiImageRequest): Promise<AiResult<AiImageResult>>;
  /** @deprecated Speech lives on `DocBlocksHostAPI.speech`; no host implements this. */
  transcribe?(request: AiTranscribeRequest): Promise<AiResult<AiTranscript>>;
  /** @deprecated Speech lives on `DocBlocksHostAPI.speech`; no host implements this. */
  synthesize?(request: AiSynthesizeRequest): Promise<AiResult<AiSpeechAudio>>;
}
