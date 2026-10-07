/**
 * Adapts the host's speech namespace to Squisq's dictation capability.
 *
 * Squisq owns the microphone, take cutting, caret and undo; the host owns the
 * recogniser. This adapter is the whole seam between them: readiness in,
 * 16 kHz WAV takes out, text back.
 */

import type { DocBlocksHostSpeechAPI, SpeechReadiness } from '@bendyline/docblocks/host';
import type {
  SpeechInputProvider,
  SpeechInputReadiness,
} from '@bendyline/squisq-editor-react/speech';

function toReadiness(readiness: SpeechReadiness): SpeechInputReadiness {
  return {
    state: readiness.state,
    ...(readiness.reason ? { reason: readiness.reason } : {}),
  };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export interface SpeechInputProviderOptions {
  /** Show the host's model setup, e.g. open Settings at the Speech section. */
  readonly onRequestSetup: () => void;
}

export function createSpeechInputProvider(
  speech: DocBlocksHostSpeechAPI,
  options: SpeechInputProviderOptions,
): SpeechInputProvider {
  const transcribe = speech.transcribe;
  return {
    id: 'docblocks-dictation',
    label: 'Dictation',
    async status() {
      if (!transcribe) return { state: 'unavailable' };
      return toReadiness((await speech.status()).stt);
    },
    onStatus(listener) {
      return speech.onStatus((status) => listener(toReadiness(status.stt)));
    },
    async prepare(signal) {
      const result = await abortable(speech.prepare('stt'), signal);
      if (!result.ok) throw new Error(result.error.message);
    },
    requestSetup: options.onRequestSetup,
    async transcribe(wav, { prompt, language, signal }) {
      if (!transcribe) throw new Error('Dictation is not available.');
      const result = await abortable(
        transcribe({
          audio: wav,
          mimeType: 'audio/wav',
          ...(prompt ? { prompt } : {}),
          ...(language ? { language } : {}),
        }),
        signal,
      );
      if (!result.ok) throw new Error(result.error.message);
      return { text: result.value.text };
    },
  };
}
