/**
 * The host-agnostic speech seam: dictation (speech to text) and narration
 * (text to speech).
 *
 * This is deliberately separate from `ai`. The AI namespace is shaped around a
 * provider connection — installed or hosted, approved or not — while speech
 * engines run inside the host itself and need only a downloaded model. A host
 * may offer speech without AI and AI without speech.
 *
 * Shapes follow the vocabulary of the Gezel audio schemas (transcribe requests
 * with a continuity prompt, synthesis streamed as independently playable
 * chunks, the `ready` / `download-required` / `unavailable` /
 * `permission-required` readiness states) so the two products describe the
 * same engines the same way. Nothing here names an engine: model and voice ids
 * are opaque strings.
 *
 * Every operation that can fail for an expected reason returns `SpeechResult`
 * rather than rejecting; a missing model is an ordinary state, not a bug.
 */

/** An expected-failure envelope. Rejections stay reserved for genuine bugs. */
export type SpeechResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SpeechError };

export type SpeechErrorCode =
  /** The operation needs a model that has not been downloaded. */
  | 'model-missing'
  | 'model-download-failed'
  /** The engine cannot run on this machine (missing runtime, OS too old). */
  | 'engine-unavailable'
  /** The engine started but failed this request, or crashed. */
  | 'engine-failed'
  | 'invalid-request'
  /** Too many requests in flight; retry after the current one finishes. */
  | 'busy'
  | 'timeout'
  | 'cancelled'
  | 'unknown';

export interface SpeechError {
  readonly code: SpeechErrorCode;
  /** Shown to the user. */
  readonly message: string;
  /** Optional diagnostic detail for logs; not for display. */
  readonly detail?: string;
}

export type SpeechModelKind = 'stt' | 'tts';

export type SpeechReadinessState =
  | 'ready'
  /** A model must be downloaded first; never started without a user gesture. */
  | 'download-required'
  /** The engine cannot run here; `reason` says why. */
  | 'unavailable'
  /** The operating system has refused microphone access to this app. */
  | 'permission-required';

/** Readiness never initiates a download, asks for permission, or warms a model. */
export interface SpeechReadiness {
  readonly state: SpeechReadinessState;
  readonly reason?: string;
  /** The model that would serve requests, when one is chosen. */
  readonly model?: string;
}

export interface SpeechStatus {
  readonly stt: SpeechReadiness;
  readonly tts: SpeechReadiness;
}

export interface SpeechModelInfo {
  readonly id: string;
  readonly kind: SpeechModelKind;
  readonly label: string;
  readonly description: string;
  readonly downloadBytes: number;
  readonly installed: boolean;
  /** An older app download exists; update it explicitly before using this model. */
  readonly updateRequired?: boolean;
  /**
   * Where the installed copy lives. `shared` is a verified read-only copy
   * another local app already downloaded, which costs this app no disk.
   */
  readonly source: 'app' | 'shared' | null;
  readonly recommended: boolean;
  readonly license: string;
  readonly licenseUrl: string;
}

export interface SpeechVoiceInfo {
  readonly id: string;
  readonly label: string;
  /** BCP 47 tag, e.g. `en-US`. */
  readonly language: string;
  readonly gender: 'female' | 'male' | null;
  /** The TTS model that speaks this voice. */
  readonly modelId: string;
}

export interface SpeechCatalog {
  readonly models: readonly SpeechModelInfo[];
  readonly voices: readonly SpeechVoiceInfo[];
}

export interface SpeechProgress {
  readonly phase: 'downloading' | 'verifying';
  readonly receivedBytes: number;
  /** Null when the server reports no length. */
  readonly totalBytes: number | null;
}

export type SpeechInstallEvent =
  | { readonly kind: 'progress'; readonly progress: SpeechProgress }
  | { readonly kind: 'done'; readonly model: SpeechModelInfo }
  | { readonly kind: 'error'; readonly error: SpeechError };

export interface SpeechInstallHandle {
  readonly done: Promise<SpeechResult<SpeechModelInfo>>;
  cancel(): void;
}

export interface SpeechPreferences {
  /** Dictation model id, or null for the recommended installed model. */
  readonly sttModel: string | null;
  /** Narration voice id, or null for the default voice. */
  readonly voice: string | null;
  /** Narration speed, 0.5 to 2. */
  readonly speed: number;
}

export type SpeechPreferencesPatch = Partial<SpeechPreferences>;

export interface SpeechTranscribeRequest {
  /** One self-contained take. */
  readonly audio: ArrayBuffer;
  readonly mimeType: 'audio/wav';
  /**
   * Recent transcript tail for continuity of vocabulary and punctuation. It is
   * a hint to the recogniser, never text to re-transcribe.
   */
  readonly prompt?: string;
  readonly language?: string;
}

export interface SpeechSegment {
  /** Seconds from the start of the take. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface SpeechTranscript {
  /** Trimmed; empty when the take held no speech. */
  readonly text: string;
  readonly language: string | null;
  readonly segments: readonly SpeechSegment[];
  readonly durationMs: number;
}

export interface SpeechSynthesizeRequest {
  readonly text: string;
  /** Voice id, or omitted for the preferred voice. */
  readonly voice?: string;
  /** 0.5 to 2, or omitted for the preferred speed. */
  readonly speed?: number;
}

/** Model-derived word allocation, relative to the chunk's audio and request text. */
export interface SpeechWordTiming {
  readonly textStart: number;
  readonly textEnd: number;
  readonly startSec: number;
  readonly endSec: number;
}

/** One independently playable piece of a synthesis, usually a sentence. */
export interface SpeechAudioChunk {
  readonly index: number;
  /** Mono 32-bit float samples. */
  readonly pcm: ArrayBuffer;
  readonly sampleRate: number;
  readonly durationSec: number;
  /** UTF-16 range of the request text this chunk speaks. */
  readonly textStart: number;
  readonly textEnd: number;
  /** Optional for engines without model durations. Expanded words may share a source range. */
  readonly wordTimings?: readonly SpeechWordTiming[];
}

export interface SpeechSynthesisSummary {
  readonly voice: string;
  readonly model: string;
  readonly sampleRate: number;
  readonly durationSec: number;
  readonly chunks: number;
}

/**
 * A finite synthesis stream. Audio always arrives as at least one `chunk`
 * before `done`, so a caller can play chunks as they come.
 */
export type SpeechSynthesizeEvent =
  | {
      readonly kind: 'progress';
      readonly phase: 'loading' | 'synthesizing';
      readonly completedCharacters: number;
      readonly totalCharacters: number;
    }
  | { readonly kind: 'chunk'; readonly chunk: SpeechAudioChunk }
  | { readonly kind: 'done'; readonly summary: SpeechSynthesisSummary }
  | { readonly kind: 'error'; readonly error: SpeechError };

export interface SpeechSynthesisHandle {
  readonly done: Promise<SpeechResult<SpeechSynthesisSummary>>;
  cancel(): void;
}

/**
 * The speech namespace on `DocBlocksHostAPI`.
 *
 * `transcribe` and `synthesize` are optional one by one: an engine can be
 * missing for this platform while the other works, and
 * `deriveHostCapabilities` observes each. A host with neither engine omits the
 * whole namespace.
 */
export interface DocBlocksHostSpeechAPI {
  status(): Promise<SpeechStatus>;
  onStatus(listener: (status: SpeechStatus) => void): () => void;
  catalog(): Promise<SpeechResult<SpeechCatalog>>;
  /** Start a model download. Called only from an explicit user gesture. */
  installModel(
    modelId: string,
    onProgress?: (progress: SpeechProgress) => void,
  ): SpeechInstallHandle;
  removeModel(modelId: string): Promise<SpeechResult<null>>;
  getPreferences(): Promise<SpeechPreferences>;
  setPreferences(patch: SpeechPreferencesPatch): Promise<SpeechPreferences>;
  /** Warm an engine ahead of a request, e.g. when the user starts dictating. */
  prepare(kind: SpeechModelKind): Promise<SpeechResult<null>>;
  transcribe?(request: SpeechTranscribeRequest): Promise<SpeechResult<SpeechTranscript>>;
  synthesize?(
    request: SpeechSynthesizeRequest,
    onEvent: (event: SpeechSynthesizeEvent) => void,
  ): SpeechSynthesisHandle;
}
