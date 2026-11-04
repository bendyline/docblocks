import {
  parseSpeechPreferences,
  parseSpeechPreferencesPatch,
  parseSpeechSynthesizeRequest,
  parseSpeechTranscribeRequest,
  type DocBlocksHostSpeechAPI,
  type SpeechCatalog,
  type SpeechError,
  type SpeechErrorCode,
  type SpeechModelInfo,
  type SpeechPreferences,
  type SpeechReadiness,
  type SpeechResult,
  type SpeechStatus,
  type SpeechSynthesisSummary,
  type SpeechSynthesizeEvent,
} from '@bendyline/docblocks/host';
import type {
  MobileSpeech,
  MobileSpeechModel,
  MobileSpeechStatus,
} from '@bendyline/gezel-capacitor';

export interface MobileSpeechHostOptions {
  /** Loads Gezel's speech module on first use; startup touches no native speech code. */
  load(): Promise<MobileSpeech>;
  readPreferences(): unknown;
  writePreferences(preferences: SpeechPreferences): void;
}

const defaults: SpeechPreferences = { sttModel: null, voice: null, speed: 1 };
const KOKORO = 'kokoro-82m-v1.0';

/** Gezel's rejections in plain words; the native text stays in `detail` for logs. */
export function speechFailure(error: unknown, download = false): SpeechError {
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : '';
  const detail = error instanceof Error ? error.message : undefined;
  const failure = (code: SpeechErrorCode, message: string): SpeechError => ({
    code,
    message,
    ...(detail && detail !== message ? { detail } : {}),
  });
  switch (code) {
    case 'cancelled':
      return failure('cancelled', download ? 'The download was cancelled.' : 'Speech stopped.');
    case 'paused':
      return failure(
        'cancelled',
        'The download paused when DocBlocks left the screen. Choose Download to continue where it stopped.',
      );
    case 'interrupted':
      return failure(
        'model-download-failed',
        'The download was interrupted. Check your connection, then choose Download to continue where it stopped.',
      );
    case 'verification':
      return failure(
        'model-download-failed',
        'The downloaded model was damaged, so it was not installed. Choose Download to try again.',
      );
    case 'storage':
      return failure(
        'model-download-failed',
        'There is not enough free storage on this device for this model.',
      );
    case 'unavailable':
      return failure('engine-unavailable', 'Offline speech is not available in this build.');
    case 'model-missing':
      return failure('model-missing', 'Download a speech model in Settings first.');
    case 'busy':
      return failure('busy', 'Speech is busy. Try again when the current request finishes.');
    case 'resources':
      return failure(
        'engine-failed',
        'This device is low on memory or too warm for speech right now. Try again in a moment.',
      );
    case 'invalid-input':
      return failure('invalid-request', 'This speech request could not be read.');
    default:
      return download
        ? failure('model-download-failed', 'The model could not be downloaded. Try again later.')
        : failure('engine-failed', 'Speech failed on this device. Try again.');
  }
}

const fail = <T>(error: SpeechError): SpeechResult<T> => ({ ok: false, error });

export function createMobileSpeechHost(options: MobileSpeechHostOptions) {
  let preferences = parseSpeechPreferences(options.readPreferences()) ?? defaults;
  let loaded: Promise<MobileSpeech> | undefined;
  const speech = () => {
    loaded ??= options.load();
    // A failed import must not stay cached as permanent.
    void loaded.catch(() => (loaded = undefined));
    return loaded;
  };
  const listeners = new Set<(status: SpeechStatus) => void>();
  const active = new Set<AbortController>();
  let installing: string | undefined;

  const info = (model: MobileSpeechModel, installed: boolean): SpeechModelInfo => ({
    id: model.id,
    kind: model.kind,
    label: model.label,
    description: model.description,
    downloadBytes: model.files.reduce((sum, file) => sum + file.size, 0),
    installed,
    source: installed ? 'app' : null,
    recommended: model.recommended,
    license: model.license,
    licenseUrl: model.licenseUrl,
  });

  /** The dictation model that would serve a request: preferred, then recommended, then any. */
  const sttModel = (engine: MobileSpeech, state: MobileSpeechStatus) => {
    const installed = engine.models.filter(
      (model) => model.kind === 'stt' && state.installed.has(model.id),
    );
    return (
      installed.find((model) => model.id === preferences.sttModel) ??
      installed.find((model) => model.recommended) ??
      installed[0]
    );
  };

  async function status(): Promise<SpeechStatus> {
    let engine: MobileSpeech, state: MobileSpeechStatus;
    try {
      engine = await speech();
      state = await engine.status();
    } catch {
      const reason = 'Offline speech could not start on this device.';
      return { stt: { state: 'unavailable', reason }, tts: { state: 'unavailable', reason } };
    }
    if (!state.available) {
      const reason = 'Offline speech is not available in this build.';
      return { stt: { state: 'unavailable', reason }, tts: { state: 'unavailable', reason } };
    }
    const chosen = sttModel(engine, state);
    const recommended = engine.models.find((model) => model.kind === 'stt' && model.recommended);
    const stt: SpeechReadiness = chosen
      ? { state: 'ready', model: chosen.id }
      : {
          state: 'download-required',
          reason: 'Download a dictation model to start dictating.',
          ...(recommended ? { model: recommended.id } : {}),
        };
    const tts: SpeechReadiness = state.installed.has(KOKORO)
      ? { state: 'ready', model: KOKORO }
      : {
          state: 'download-required',
          reason: 'Download the narration voices to read documents aloud.',
          model: KOKORO,
        };
    return { stt, tts };
  }

  const publish = () => {
    if (!listeners.size) return;
    void status().then((value) => {
      for (const listener of listeners) listener(value);
    });
  };

  const api: DocBlocksHostSpeechAPI = {
    status,
    onStatus(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async catalog(): Promise<SpeechResult<SpeechCatalog>> {
      try {
        const engine = await speech();
        const state = await engine.status();
        return {
          ok: true,
          value: {
            models: engine.models.map((model) => info(model, state.installed.has(model.id))),
            voices: engine.models.flatMap((model) =>
              (model.voices ?? []).map((voice) => ({
                id: voice.id,
                label: voice.label,
                language: voice.language,
                gender: voice.gender,
                modelId: model.id,
              })),
            ),
          },
        };
      } catch (error) {
        return fail(speechFailure(error));
      }
    },
    installModel(modelId, onProgress) {
      const controller = new AbortController();
      const done = (async (): Promise<SpeechResult<SpeechModelInfo>> => {
        if (installing)
          return fail({ code: 'busy', message: 'Another speech model is downloading.' });
        installing = modelId;
        try {
          const engine = await speech();
          const model = engine.models.find((entry) => entry.id === modelId);
          if (!model)
            return fail({
              code: 'invalid-request',
              message: 'This speech model is not available on this device.',
            });
          await engine.install(modelId, {
            signal: controller.signal,
            onProgress: (progress) =>
              onProgress?.({
                phase: 'downloading',
                receivedBytes: progress.receivedBytes,
                totalBytes: progress.totalBytes,
              }),
          });
          return { ok: true, value: info(model, true) };
        } catch (error) {
          return fail(speechFailure(error, true));
        } finally {
          installing = undefined;
          publish();
        }
      })();
      return { done, cancel: () => controller.abort() };
    },
    async removeModel(modelId) {
      try {
        await (await speech()).remove(modelId);
        return { ok: true, value: null };
      } catch (error) {
        return fail(speechFailure(error));
      } finally {
        publish();
      }
    },
    getPreferences: async () => ({ ...preferences }),
    async setPreferences(raw) {
      const patch = parseSpeechPreferencesPatch(raw);
      if (!patch) throw new TypeError('Invalid speech preferences.');
      preferences = { ...preferences, ...patch };
      options.writePreferences(preferences);
      publish();
      return { ...preferences };
    },
    // Models load on first use; warming would hold memory a phone may need.
    async prepare(kind) {
      const readiness = (await status())[kind];
      if (readiness.state === 'ready') return { ok: true, value: null };
      return fail({
        code: readiness.state === 'download-required' ? 'model-missing' : 'engine-unavailable',
        message: readiness.reason ?? 'Offline speech is not available on this device.',
      });
    },
    async transcribe(raw) {
      const request = parseSpeechTranscribeRequest(raw);
      if (!request)
        return fail({ code: 'invalid-request', message: 'This recording could not be read.' });
      const controller = new AbortController();
      active.add(controller);
      try {
        const engine = await speech();
        const model = sttModel(engine, await engine.status());
        if (!model)
          return fail({
            code: 'model-missing',
            message: 'Download a dictation model in Settings first.',
          });
        const transcript = await engine.transcribe({
          wav: new Uint8Array(request.audio),
          model: model.id,
          ...(request.language ? { language: request.language } : {}),
          ...(request.prompt ? { prompt: request.prompt } : {}),
          ...(request.timestamps ? { words: true } : {}),
          signal: controller.signal,
        });
        return {
          ok: true,
          value: {
            text: transcript.text,
            language: transcript.language,
            segments: transcript.segments.map(({ start, end, text, words }) => ({
              start,
              end,
              text,
              ...(request.timestamps && words ? { words } : {}),
            })),
            durationMs: transcript.durationMs,
          },
        };
      } catch (error) {
        return fail(speechFailure(error));
      } finally {
        active.delete(controller);
      }
    },
    synthesize(raw, onEvent) {
      const controller = new AbortController();
      const emit = (event: SpeechSynthesizeEvent) => {
        try {
          onEvent(event);
        } catch {
          // A failing listener must not stop the synthesis it observes.
        }
      };
      const done = (async (): Promise<SpeechResult<SpeechSynthesisSummary>> => {
        const finish = (error: SpeechError): SpeechResult<SpeechSynthesisSummary> => {
          emit({ kind: 'error', error });
          return fail(error);
        };
        const request = parseSpeechSynthesizeRequest(raw);
        if (!request)
          return finish({ code: 'invalid-request', message: 'There is nothing to read aloud.' });
        active.add(controller);
        try {
          const engine = await speech();
          emit({
            kind: 'progress',
            phase: 'loading',
            completedCharacters: 0,
            totalCharacters: request.text.length,
          });
          const summary = await engine.synthesize({
            text: request.text,
            voice: request.voice ?? preferences.voice ?? undefined,
            speed: request.speed ?? preferences.speed,
            signal: controller.signal,
            onProgress: (completedCharacters, totalCharacters) =>
              emit({
                kind: 'progress',
                phase: 'synthesizing',
                completedCharacters,
                totalCharacters,
              }),
            onChunk: (chunk) =>
              emit({
                kind: 'chunk',
                chunk: {
                  index: chunk.index,
                  pcm: chunk.pcm.buffer.slice(
                    chunk.pcm.byteOffset,
                    chunk.pcm.byteOffset + chunk.pcm.byteLength,
                  ) as ArrayBuffer,
                  sampleRate: chunk.sampleRate,
                  durationSec: chunk.durationSec,
                  textStart: chunk.textStart,
                  textEnd: chunk.textEnd,
                  ...(chunk.wordTimings ? { wordTimings: chunk.wordTimings } : {}),
                },
              }),
          });
          emit({ kind: 'done', summary });
          return { ok: true, value: summary };
        } catch (error) {
          return finish(speechFailure(error));
        } finally {
          active.delete(controller);
        }
      })();
      return { done, cancel: () => controller.abort() };
    },
  };

  return {
    speech: api,
    /** Leaving the screen stops speech; native code also stops and frees its models. */
    suspend() {
      for (const controller of active) controller.abort();
    },
    resume: publish,
  };
}
