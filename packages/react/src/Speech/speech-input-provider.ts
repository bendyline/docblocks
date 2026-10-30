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

/**
 * Drop the ellipses Whisper writes for pauses.
 *
 * Takes are cut at every breath, so Whisper ends nearly each one with "..." —
 * and since each take's text primes the next take's prompt, the habit
 * compounds until every pause carries one. A pause is not punctuation the
 * speaker asked for: the ellipsis becomes a word break, a take that was only
 * an ellipsis becomes silence, and any space it leaves before closing
 * punctuation closes up.
 */
export function stripPauseEllipses(transcript: string): string {
  return transcript
    .replace(/(?:\.{3,}|…)+/gu, ' ')
    .replace(/\s+([,;:!?]|\.(?=\s|$))/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Sign-offs Whisper invents for near silence, recognized only as a whole take. */
const SILENCE_SIGN_OFF =
  /^(?:(?:thanks|thank you)(?: (?:so|very) much)? for watching|please subscribe|subtitles by the amara\.org community)[.!]*$/iu;

/**
 * Drop the captions Whisper writes when it hears no speech.
 *
 * Trained on subtitles, it captions room noise the way subtitles caption a
 * soundtrack — `[Music]`, `[wind]`, `(wind blowing)`, `♪` — and on near
 * silence it signs off like a video: "Thanks for watching!". None of it was
 * said, and since each take's text primes the next take's prompt, one caption
 * invites the same caption at every later pause. Nobody dictates square
 * brackets or music notes, so those go wherever they appear; a parenthetical
 * can be spoken, so it goes only when it is the whole take. A take that was
 * only captions becomes silence.
 */
export function stripNonSpeechCues(transcript: string): string {
  const text = transcript
    .replace(/\[[^\]]*\]|[♪♫♬]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (/^(?:\([^()]*\)[\s.,;:!?]*)+$/u.test(text) || SILENCE_SIGN_OFF.test(text)) return '';
  return text;
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
    async transcribe(wav, { prompt, language, timestamps, signal }) {
      if (!transcribe) throw new Error('Dictation is not available.');
      const result = await abortable(
        transcribe({
          audio: wav,
          mimeType: 'audio/wav',
          ...(prompt ? { prompt } : {}),
          ...(language ? { language } : {}),
          ...(timestamps ? { timestamps: true } : {}),
        }),
        signal,
      );
      if (!result.ok) throw new Error(result.error.message);
      const text = stripPauseEllipses(stripNonSpeechCues(result.value.text));
      // Timed segments are for matching, not insertion: they stay verbatim.
      return timestamps ? { text, segments: result.value.segments } : { text };
    },
  };
}
