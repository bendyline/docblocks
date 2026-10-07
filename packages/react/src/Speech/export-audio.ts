/**
 * Turn a document into an audio file.
 *
 * A document with a narration track (recorded or generated) is mixed exactly
 * as video export mixes it — same doc projection, same timeline — so the audio
 * matches what Play mode and an exported video sound like. A document without
 * one is narrated on the fly with the narration voice, without touching it.
 */

import type { DocBlocksHostSpeechAPI } from '@bendyline/docblocks/host';
import type { AudioFileEncoder, AudioFileFormat } from '@bendyline/squisq-video-react/encoder';
import type { MediaClip, MediaProvider } from '@bendyline/squisq/schemas';
import type { ContentContainer } from '@bendyline/squisq/storage';
import { buildVideoExportDoc } from '../Export/video-export-doc.js';
import { planSpeech } from './speakable-text.js';

export const AUDIO_FORMAT_LABELS: Readonly<Record<AudioFileFormat, string>> = {
  m4a: 'M4A (AAC)',
  'opus-webm': 'WebM (Opus)',
  wav: 'WAV (uncompressed)',
};

const LONG_DOCUMENT_SECONDS = 10 * 60;

/** Seconds of audio handed to the encoder per append, so memory stays flat. */
const APPEND_SECONDS = 2;

export function audioExportFilename(selectedFile: string | null, extension: string): string {
  const base = (selectedFile ?? 'document').split('/').pop() ?? 'document';
  return `${base.replace(/\.[^.]+$/u, '') || 'document'}.${extension}`;
}

async function encoderFor(format: AudioFileFormat, sampleRate: number, channels: 1 | 2) {
  const { createAudioFileEncoder } = await import('@bendyline/squisq-video-react/encoder');
  return createAudioFileEncoder({ format, sampleRate, channels });
}

async function finishOrCancel(
  encoder: AudioFileEncoder,
  signal: AbortSignal | undefined,
): Promise<Blob> {
  if (signal?.aborted) {
    await encoder.cancel().catch(() => undefined);
    throw new DOMException('Audio export cancelled.', 'AbortError');
  }
  return encoder.finish();
}

/** Mix the document's narration track. Null when the document has no audio. */
export async function exportNarrationAudio(input: {
  readonly markdown: string;
  readonly fileName: string | null;
  readonly workspaceContainer: ContentContainer | null;
  readonly mediaProvider: MediaProvider;
  /** Media-edit renders (e.g. "Clean up voice"), mixed in place of their sources. */
  readonly processedAudio?: (clip: MediaClip) => string | undefined;
  readonly format: AudioFileFormat;
  readonly signal?: AbortSignal;
}): Promise<{ blob: Blob; extension: string } | null> {
  const [{ renderDocumentAudio }, doc] = await Promise.all([
    import('@bendyline/squisq-video-react/encoder'),
    buildVideoExportDoc(input.markdown, {
      fileName: input.fileName ?? undefined,
      workspaceContainer: input.workspaceContainer,
    }),
  ]);
  // The mix is held whole before encoding (~23 MB a minute at 48 kHz stereo),
  // so long documents mix at 24 kHz, which is still more than speech needs.
  const rendered = await renderDocumentAudio(doc, {
    sampleRate: (doc.duration ?? 0) > LONG_DOCUMENT_SECONDS ? 24_000 : 48_000,
    ...(input.processedAudio ? { processedAudio: input.processedAudio } : {}),
    async readMedia(src) {
      const url = await input.mediaProvider.resolveUrl(src);
      const response = await fetch(url);
      return response.ok ? response.arrayBuffer() : null;
    },
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!rendered) return null;
  const channels = rendered.numberOfChannels > 1 ? 2 : 1;
  const encoder = await encoderFor(input.format, rendered.sampleRate, channels);
  try {
    const step = Math.round(rendered.sampleRate * APPEND_SECONDS);
    for (let offset = 0; offset < rendered.length; offset += step) {
      if (input.signal?.aborted) break;
      const end = Math.min(rendered.length, offset + step);
      const planar = Array.from({ length: channels }, (_, channel) =>
        rendered.getChannelData(channel).slice(offset, end),
      );
      await encoder.append(planar);
    }
    return { blob: await finishOrCancel(encoder, input.signal), extension: encoder.extension };
  } catch (error) {
    await encoder.cancel().catch(() => undefined);
    throw error;
  }
}

/** Narrate the document with the narration voice, straight into the encoder. */
export async function exportSpokenAudio(input: {
  readonly markdown: string;
  readonly speech: DocBlocksHostSpeechAPI;
  readonly format: AudioFileFormat;
  readonly onProgress?: (done: number, total: number) => void;
  readonly signal?: AbortSignal;
}): Promise<{ blob: Blob; extension: string }> {
  const synthesize = input.speech.synthesize;
  if (!synthesize) throw new Error('Narration is not available.');
  const plan = await planSpeech(input.markdown);
  if (plan.segments.length === 0) throw new Error('There is nothing to read aloud.');
  const encoder = await encoderFor(input.format, 24_000, 1);
  try {
    let appending: Promise<void> = Promise.resolve();
    for (const [index, segment] of plan.segments.entries()) {
      if (input.signal?.aborted) break;
      input.onProgress?.(index, plan.segments.length);
      const handle = synthesize({ text: segment.text }, (event) => {
        if (event.kind !== 'chunk') return;
        const samples = new Float32Array(event.chunk.pcm);
        appending = appending.then(() => encoder.append([samples]));
      });
      const onAbort = () => handle.cancel();
      input.signal?.addEventListener('abort', onAbort, { once: true });
      const result = await handle.done;
      input.signal?.removeEventListener('abort', onAbort);
      if (!result.ok) {
        if (result.error.code === 'cancelled') break;
        throw new Error(result.error.message);
      }
    }
    await appending;
    input.onProgress?.(plan.segments.length, plan.segments.length);
    return { blob: await finishOrCancel(encoder, input.signal), extension: encoder.extension };
  } catch (error) {
    await encoder.cancel().catch(() => undefined);
    throw error;
  }
}
