import type {
  SpeechCatalog,
  SpeechError,
  SpeechErrorCode,
  SpeechInstallEvent,
  SpeechModelInfo,
  SpeechModelKind,
  SpeechPreferences,
  SpeechPreferencesPatch,
  SpeechReadiness,
  SpeechResult,
  SpeechStatus,
  SpeechSynthesisSummary,
  SpeechSynthesizeEvent,
  SpeechSynthesizeRequest,
  SpeechTranscribeRequest,
  SpeechTranscript,
} from '@bendyline/docblocks/host';
import {
  KOKORO_DEFAULT_VOICE,
  KOKORO_MODEL_FILE,
  KOKORO_VOICES,
  type LocatedModel,
  type SpeechModelStore,
} from './speech-models.js';
import type { SpeechPreferenceStore } from './speech-preferences.js';
import { VerifiedDownloadError } from './verified-download.js';
import { KokoroEngineError } from './kokoro-engine.js';
import { WhisperEngineError } from './whisper-engine.js';

/**
 * The speech orchestrator. Knows nothing about Electron: main constructs it
 * with whatever engines exist for this platform, and `ipc-speech.ts` adapts
 * it to the renderer. Engines are optional one by one — a platform may have a
 * dictation engine and no narration engine, or the reverse.
 */

export interface SttEngine {
  prepare(model: string, signal?: AbortSignal): Promise<void>;
  transcribe(
    model: string,
    input: { audio: ArrayBuffer; prompt?: string; language?: string },
    signal?: AbortSignal,
  ): Promise<SpeechTranscript>;
  stop(): Promise<void>;
}

export interface TtsSynthesisInput {
  readonly modelFile: string;
  readonly voiceFile: string;
  readonly voice: string;
  readonly text: string;
  readonly speed: number;
}

export interface TtsEngine {
  prepare(modelFile: string, signal?: AbortSignal): Promise<void>;
  synthesize(
    input: TtsSynthesisInput,
    onEvent: (event: Exclude<SpeechSynthesizeEvent, { kind: 'done' | 'error' }>) => void,
    signal?: AbortSignal,
  ): Promise<SpeechSynthesisSummary>;
  stop(): Promise<void>;
}

/** An engine that cannot run here, and why — shown as readiness `unavailable`. */
export interface UnavailableEngine {
  readonly unavailable: string;
}

export type MicrophoneAccess = 'granted' | 'denied' | 'not-determined' | 'unknown';

export interface SpeechServiceOptions {
  readonly models: SpeechModelStore;
  readonly preferences: SpeechPreferenceStore;
  readonly stt: SttEngine | UnavailableEngine;
  readonly tts: TtsEngine | UnavailableEngine;
  /** OS-level microphone permission, where the platform reports one. */
  readonly microphoneAccess?: () => MicrophoneAccess;
}

const MAX_CONCURRENT_INSTALLS = 2;

function isUnavailable(engine: unknown): engine is UnavailableEngine {
  return typeof (engine as UnavailableEngine).unavailable === 'string';
}

export function speechError(code: SpeechErrorCode, message: string, detail?: string): SpeechError {
  return { code, message, ...(detail ? { detail: detail.slice(0, 2_000) } : {}) };
}

/** Map anything an engine or download throws into the wire error vocabulary. */
export function toSpeechError(error: unknown): SpeechError {
  if (error instanceof WhisperEngineError) {
    return speechError(error.failure, error.message, error.detail);
  }
  if (error instanceof KokoroEngineError) {
    return speechError(error.code, error.message, error.detail);
  }
  if (error instanceof VerifiedDownloadError) {
    if (error.failure === 'aborted') return speechError('cancelled', 'Download cancelled.');
    if (error.failure === 'timeout') return speechError('timeout', error.message);
    return speechError('model-download-failed', error.message);
  }
  if (isSpeechError(error)) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return speechError('unknown', 'Something went wrong with speech.', detail);
}

function isSpeechError(value: unknown): value is SpeechError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SpeechError).code === 'string' &&
    typeof (value as SpeechError).message === 'string'
  );
}

export class SpeechService {
  private readonly options: SpeechServiceOptions;
  private readonly listeners = new Set<(status: SpeechStatus) => void>();
  private readonly installs = new Map<string, AbortController>();
  private readonly syntheses = new Map<string, AbortController>();

  constructor(options: SpeechServiceOptions) {
    this.options = options;
  }

  get sttAvailable(): boolean {
    return !isUnavailable(this.options.stt);
  }

  get ttsAvailable(): boolean {
    return !isUnavailable(this.options.tts);
  }

  onStatus(listener: (status: SpeechStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async publish(): Promise<void> {
    if (this.listeners.size === 0) return;
    const status = await this.status();
    for (const listener of this.listeners) listener(status);
  }

  /** The STT model that would serve a request: preferred, then recommended, then any. */
  private async chooseSttModel(
    models: readonly SpeechModelInfo[],
  ): Promise<SpeechModelInfo | null> {
    const prefs = await this.options.preferences.get();
    const stt = models.filter((model) => model.kind === 'stt');
    const installed = stt.filter((model) => model.installed);
    return (
      installed.find((model) => model.id === prefs.sttModel) ??
      installed.find((model) => model.recommended) ??
      installed[0] ??
      null
    );
  }

  async status(): Promise<SpeechStatus> {
    const models = await this.options.models.list();
    return { stt: await this.sttReadiness(models), tts: this.ttsReadiness(models) };
  }

  private async sttReadiness(models: readonly SpeechModelInfo[]): Promise<SpeechReadiness> {
    const engine = this.options.stt;
    if (isUnavailable(engine)) return { state: 'unavailable', reason: engine.unavailable };
    if (this.options.microphoneAccess?.() === 'denied') {
      return {
        state: 'permission-required',
        reason: 'Allow DocBlocks to use the microphone in your system privacy settings.',
      };
    }
    const chosen = await this.chooseSttModel(models);
    if (chosen) return { state: 'ready', model: chosen.id };
    const recommended = models.find((model) => model.kind === 'stt' && model.recommended);
    return {
      state: 'download-required',
      reason: recommended?.updateRequired
        ? 'Update the dictation model in Settings to start dictating.'
        : 'Download a dictation model to start dictating.',
      ...(recommended ? { model: recommended.id } : {}),
    };
  }

  private ttsReadiness(models: readonly SpeechModelInfo[]): SpeechReadiness {
    const engine = this.options.tts;
    if (isUnavailable(engine)) return { state: 'unavailable', reason: engine.unavailable };
    const model = models.find((entry) => entry.kind === 'tts');
    if (!model) return { state: 'unavailable', reason: 'No narration voices are available.' };
    return model.installed
      ? { state: 'ready', model: model.id }
      : {
          state: 'download-required',
          reason: model.updateRequired
            ? 'Update the narration model in Settings to read documents aloud.'
            : 'Download the narration voices to read documents aloud.',
          model: model.id,
        };
  }

  async catalog(): Promise<SpeechResult<SpeechCatalog>> {
    const models = (await this.options.models.list()).filter((model) =>
      model.kind === 'stt' ? this.sttAvailable : this.ttsAvailable,
    );
    const voices = this.ttsAvailable
      ? KOKORO_VOICES.map(({ sha256: _sha, ...voice }) => voice)
      : [];
    return { ok: true, value: { models, voices } };
  }

  getPreferences(): Promise<SpeechPreferences> {
    return this.options.preferences.get();
  }

  async setPreferences(patch: SpeechPreferencesPatch): Promise<SpeechPreferences> {
    if (patch.sttModel != null) {
      const entry = this.options.models.entry(patch.sttModel);
      if (!entry || entry.kind !== 'stt') throw new Error('Unknown dictation model');
    }
    if (patch.voice != null && !KOKORO_VOICES.some((voice) => voice.id === patch.voice)) {
      throw new Error('Unknown narration voice');
    }
    const next = await this.options.preferences.set(patch);
    if (patch.sttModel !== undefined && !isUnavailable(this.options.stt)) {
      // The running server holds the previous model.
      await this.options.stt.stop();
    }
    void this.publish();
    return next;
  }

  /** Start a model install; events stream to `emit` until `done` or `error`. */
  startInstall(key: string, modelId: string, emit: (event: SpeechInstallEvent) => void): void {
    const entry = this.options.models.entry(modelId);
    if (!entry) {
      emit({ kind: 'error', error: speechError('invalid-request', 'Unknown speech model.') });
      return;
    }
    if (entry.kind === 'stt' ? !this.sttAvailable : !this.ttsAvailable) {
      emit({
        kind: 'error',
        error: speechError('engine-unavailable', 'This model cannot run on this computer.'),
      });
      return;
    }
    if (this.installs.size >= MAX_CONCURRENT_INSTALLS) {
      emit({ kind: 'error', error: speechError('busy', 'Another download is in progress.') });
      return;
    }
    const controller = new AbortController();
    this.installs.set(key, controller);
    let lastReported = -1;
    void this.options.models
      .install(modelId, {
        signal: controller.signal,
        onProgress: (receivedBytes, totalBytes) => {
          // At most one event per percent; the renderer only draws a bar.
          const percent = Math.floor((receivedBytes / Math.max(1, totalBytes)) * 100);
          if (percent === lastReported && receivedBytes !== totalBytes) return;
          lastReported = percent;
          emit({
            kind: 'progress',
            progress: {
              phase: receivedBytes >= totalBytes ? 'verifying' : 'downloading',
              receivedBytes,
              totalBytes,
            },
          });
        },
      })
      .then(async () => {
        emit({ kind: 'done', model: await this.options.models.info(entry) });
        void this.publish();
      })
      .catch((error: unknown) => emit({ kind: 'error', error: toSpeechError(error) }))
      .finally(() => this.installs.delete(key));
  }

  cancelInstall(key: string): void {
    this.installs.get(key)?.abort();
  }

  async removeModel(modelId: string): Promise<SpeechResult<null>> {
    const entry = this.options.models.entry(modelId);
    if (!entry)
      return { ok: false, error: speechError('invalid-request', 'Unknown speech model.') };
    const engine = entry.kind === 'stt' ? this.options.stt : this.options.tts;
    if (!isUnavailable(engine)) await engine.stop();
    await this.options.models.remove(modelId);
    void this.publish();
    return { ok: true, value: null };
  }

  private async locateStt(): Promise<LocatedModel | SpeechError> {
    const chosen = await this.chooseSttModel(await this.options.models.list());
    const located = chosen ? await this.options.models.locate(chosen.id) : null;
    return (
      located ??
      speechError('model-missing', 'Download a dictation model in Settings to start dictating.')
    );
  }

  private async locateTts(): Promise<LocatedModel | SpeechError> {
    const entry = this.options.models.catalog.find((model) => model.kind === 'tts');
    const located = entry ? await this.options.models.locate(entry.id) : null;
    return (
      located ??
      speechError('model-missing', 'Download the narration voices in Settings to read aloud.')
    );
  }

  async prepare(kind: SpeechModelKind): Promise<SpeechResult<null>> {
    try {
      if (kind === 'stt') {
        const engine = this.options.stt;
        if (isUnavailable(engine)) throw speechError('engine-unavailable', engine.unavailable);
        const located = await this.locateStt();
        if (isSpeechError(located)) throw located;
        await engine.prepare(firstFile(located));
      } else {
        const engine = this.options.tts;
        if (isUnavailable(engine)) throw speechError('engine-unavailable', engine.unavailable);
        const located = await this.locateTts();
        if (isSpeechError(located)) throw located;
        await engine.prepare(located.files[KOKORO_MODEL_FILE] ?? '');
      }
      return { ok: true, value: null };
    } catch (error) {
      return { ok: false, error: toSpeechError(error) };
    }
  }

  async transcribe(request: SpeechTranscribeRequest): Promise<SpeechResult<SpeechTranscript>> {
    const engine = this.options.stt;
    if (isUnavailable(engine)) {
      return { ok: false, error: speechError('engine-unavailable', engine.unavailable) };
    }
    const located = await this.locateStt();
    if (isSpeechError(located)) return { ok: false, error: located };
    try {
      const transcript = await engine.transcribe(firstFile(located), {
        audio: request.audio,
        ...(request.prompt ? { prompt: request.prompt } : {}),
        ...(request.language ? { language: request.language } : {}),
      });
      return { ok: true, value: transcript };
    } catch (error) {
      return { ok: false, error: toSpeechError(error) };
    }
  }

  /** Start a synthesis; events stream to `emit` ending in `done` or `error`. */
  startSynthesis(
    key: string,
    request: SpeechSynthesizeRequest,
    emit: (event: SpeechSynthesizeEvent) => void,
  ): void {
    const controller = new AbortController();
    this.syntheses.set(key, controller);
    void (async () => {
      const engine = this.options.tts;
      if (isUnavailable(engine)) throw speechError('engine-unavailable', engine.unavailable);
      const located = await this.locateTts();
      if (isSpeechError(located)) throw located;
      const prefs = await this.options.preferences.get();
      const voice = request.voice ?? prefs.voice ?? KOKORO_DEFAULT_VOICE;
      const voiceFile = located.files[`voices/${voice}.bin`];
      if (!voiceFile) throw speechError('invalid-request', 'That voice is not available.');
      return engine.synthesize(
        {
          modelFile: located.files[KOKORO_MODEL_FILE] ?? '',
          voiceFile,
          voice,
          text: request.text,
          speed: request.speed ?? prefs.speed,
        },
        emit,
        controller.signal,
      );
    })()
      .then((summary) => emit({ kind: 'done', summary }))
      .catch((error: unknown) => {
        emit({
          kind: 'error',
          error: controller.signal.aborted
            ? speechError('cancelled', 'Narration stopped.')
            : toSpeechError(error),
        });
      })
      .finally(() => this.syntheses.delete(key));
  }

  cancelSynthesis(key: string): void {
    this.syntheses.get(key)?.abort();
  }

  async dispose(): Promise<void> {
    for (const controller of [...this.installs.values(), ...this.syntheses.values()]) {
      controller.abort();
    }
    await Promise.all(
      [this.options.stt, this.options.tts].map((engine) =>
        isUnavailable(engine) ? undefined : engine.stop().catch(() => undefined),
      ),
    );
  }
}

function firstFile(located: LocatedModel): string {
  const name = located.entry.files[0]?.name ?? '';
  return located.files[name] ?? '';
}
