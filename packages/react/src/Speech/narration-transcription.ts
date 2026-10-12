import {
  encodeMonoPcm16Wav,
  SPEECH_INPUT_SAMPLE_RATE,
  type SpeechInputProvider,
} from '@bendyline/squisq-editor-react/speech';

export const MAX_NARRATION_AUDIO_BYTES = 25 * 1024 * 1024;
export const MAX_NARRATION_SECONDS = 10 * 60;
const TAKE_SECONDS = 25;

/** Reject oversized durations before Web Audio allocates the decoded PCM. */
async function checkAudioDuration(file: Blob, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const url = URL.createObjectURL(file);
  const media = new Audio();
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        media.onloadedmetadata = null;
        media.onerror = null;
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(new DOMException('Aborted', 'AbortError'));
      const timeout = setTimeout(
        () => finish(new Error('Audio information could not be read. Try a WAV or MP3 file.')),
        10_000,
      );
      signal.addEventListener('abort', abort, { once: true });
      media.onloadedmetadata = () => {
        if (!Number.isFinite(media.duration) || media.duration <= 0) {
          finish(
            new Error('This file has no readable duration. Export it as WAV or MP3 and try again.'),
          );
        } else if (media.duration > MAX_NARRATION_SECONDS) {
          finish(new Error('Choose audio up to 10 minutes long.'));
        } else finish();
      };
      media.onerror = () =>
        finish(new Error('This audio could not be read. Try WAV, MP3, M4A or WebM audio.'));
      media.preload = 'metadata';
      media.src = url;
    });
  } finally {
    media.removeAttribute('src');
    media.load();
    URL.revokeObjectURL(url);
  }
}

export async function decodeNarrationAudio(file: Blob, signal: AbortSignal): Promise<AudioBuffer> {
  if (!file.size || file.size > MAX_NARRATION_AUDIO_BYTES) {
    throw new Error('Choose a non-empty audio file up to 25 MB.');
  }
  await checkAudioDuration(file, signal);
  signal.throwIfAborted();
  try {
    const context = new OfflineAudioContext(1, 1, SPEECH_INPUT_SAMPLE_RATE);
    const audio = await context.decodeAudioData(await file.arrayBuffer());
    signal.throwIfAborted();
    if (audio.duration > MAX_NARRATION_SECONDS) {
      throw new Error('Choose audio up to 10 minutes long.');
    }
    if (!audio.length || audio.length * audio.numberOfChannels * 4 > 64 * 1024 * 1024) {
      throw new Error('The decoded audio is empty or too large.');
    }
    return audio;
  } catch (error) {
    if (error instanceof Error && error.name !== 'EncodingError') throw error;
    throw new Error('This audio could not be decoded. Try WAV, MP3, M4A or WebM audio.');
  }
}

/** Serial, independently encoded WAV takes stay below the host IPC budget. */
export async function transcribeNarrationAudio(
  audio: AudioBuffer,
  provider: SpeechInputProvider,
  signal: AbortSignal,
  onText: (text: string) => void,
  onProgress: (percent: number) => void,
): Promise<void> {
  signal.throwIfAborted();
  await provider.prepare?.(signal);
  const size = Math.floor(audio.sampleRate * TAKE_SECONDS);
  let tail = '';
  for (let start = 0; start < audio.length; start += size) {
    signal.throwIfAborted();
    const end = Math.min(start + size, audio.length);
    const channels = Array.from({ length: audio.numberOfChannels }, (_, index) =>
      audio.getChannelData(index).subarray(start, end),
    );
    const wav = (await encodeMonoPcm16Wav(channels, audio.sampleRate)).buffer;
    signal.throwIfAborted();
    const result = await provider.transcribe(wav, { signal, prompt: tail });
    signal.throwIfAborted();
    const text = result.text.trim();
    if (text) {
      onText(text);
      tail = `${tail} ${text}`.slice(-1_000).replace(/^\S*\s/u, '');
    }
    onProgress(Math.round((end / audio.length) * 100));
  }
}
