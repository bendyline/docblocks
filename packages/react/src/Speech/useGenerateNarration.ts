/**
 * Generate narration for the open document and save it the way a recorded
 * take is saved: an audio file and v3 timing sidecar in `<doc>_files/`, plus
 * the document-anchored `{[audio … anchor=document]}` preamble line. Play mode,
 * block timing and video export then use it with no special casing.
 *
 * Audio streams straight into Squisq's encoder as each sentence arrives, so a
 * long document never sits in memory as raw float samples.
 *
 * The screen stays on while it runs. If the app leaves the screen anyway (the
 * power button, another app), a phone stops speech; generation then waits
 * and picks up after the last sentence it heard once the app is back.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditorContext } from '@bendyline/squisq-editor-react';
import {
  buildNarrationSavePlan,
  executeNarrationSave,
} from '@bendyline/squisq-editor-react/teleprompter';
import type { DocBlocksHostSpeechAPI } from '@bendyline/docblocks/host';
import { useScreenWakeLock } from '../hooks/screen-wake-lock.js';
import { synthesizeResumably, watchPageInterruptions } from './resumable-synthesis.js';
import { planSpeech } from './speakable-text.js';
import { buildTtsAlignment, spokenSpanForChunk, type SpokenSpan } from './tts-narration.js';

export type GenerateNarrationState =
  | { readonly phase: 'idle' }
  | {
      readonly phase: 'generating';
      readonly done: number;
      readonly total: number;
      /** The app left the screen partway; this part continues where it stopped. */
      readonly resuming: boolean;
    }
  | { readonly phase: 'saving' }
  | { readonly phase: 'done'; readonly durationSec: number }
  | { readonly phase: 'error'; readonly message: string };

/** The provenance stamped into the sidecar's `generator`. */
export const TTS_NARRATION_GENERATOR = { name: 'docblocks-kokoro', method: 'tts' } as const;

/** A document already carries a document-anchored narration line. */
export function hasDocumentNarration(markdown: string): boolean {
  return /\{\[audio\b[^\]]*\banchor=document\b[^\]]*\]\}/u.test(markdown);
}

export interface GenerateNarration {
  readonly state: GenerateNarrationState;
  readonly available: boolean;
  generate(): void;
  cancel(): void;
  reset(): void;
}

export function useGenerateNarration(speech: DocBlocksHostSpeechAPI): GenerateNarration {
  const {
    markdownSource,
    setMarkdownSource,
    mediaProvider,
    workspaceContainer,
    bumpMediaRevision,
  } = useEditorContext();
  const [state, setState] = useState<GenerateNarrationState>({ phase: 'idle' });
  const sourceRef = useRef(markdownSource);
  sourceRef.current = markdownSource;
  const run = useRef<AbortController | null>(null);
  useScreenWakeLock(state.phase === 'generating' || state.phase === 'saving');

  const cancel = useCallback(() => {
    run.current?.abort();
    run.current = null;
    setState({ phase: 'idle' });
  }, []);

  useEffect(() => () => run.current?.abort(), []);

  const generate = useCallback(() => {
    const synthesize = speech.synthesize;
    if (!synthesize || !mediaProvider || run.current) return;
    const current = new AbortController();
    const { signal } = current;
    run.current = current;
    const page = watchPageInterruptions(document);
    setState({ phase: 'generating', done: 0, total: 1, resuming: false });

    void (async () => {
      const [plan, { createAudioFileEncoder }] = await Promise.all([
        planSpeech(sourceRef.current),
        import('@bendyline/squisq-video-react/encoder'),
      ]);
      if (signal.aborted) return;
      if (plan.segments.length === 0) throw new Error('There is nothing to narrate yet.');
      const encoder = await createAudioFileEncoder({
        format: 'opus-webm',
        sampleRate: 24_000,
        channels: 1,
      });
      try {
        const spans: SpokenSpan[] = [];
        let elapsed = 0;
        // Appends are ordered: each waits for the one before it.
        let appending: Promise<void> = Promise.resolve();
        const total = plan.segments.length;
        for (const [index, segment] of plan.segments.entries()) {
          if (signal.aborted) return;
          setState({ phase: 'generating', done: index, total, resuming: false });
          let resuming = false;
          await synthesizeResumably({
            text: segment.text,
            synthesize,
            page,
            signal,
            onInterrupted: () => {
              resuming = true;
              setState({ phase: 'generating', done: index, total, resuming: true });
            },
            onChunk: (chunk) => {
              if (resuming) {
                resuming = false;
                setState({ phase: 'generating', done: index, total, resuming: false });
              }
              spans.push(spokenSpanForChunk(chunk, segment, elapsed));
              elapsed += chunk.durationSec;
              const samples = new Float32Array(chunk.pcm);
              appending = appending.then(() => encoder.append([samples]));
            },
          });
          if (signal.aborted) return;
        }
        await appending;
        if (signal.aborted) return;
        setState({ phase: 'saving' });
        const audio = await encoder.finish();
        const savePlan = buildNarrationSavePlan({
          script: plan.script,
          alignment: buildTtsAlignment(plan.script, spans, elapsed),
          durationSec: elapsed,
          // Squisq's recorder extensions carry the dot (".webm").
          audioExt: `.${encoder.extension}`,
          cameraExt: null,
          generator: TTS_NARRATION_GENERATOR,
        });
        await executeNarrationSave(
          savePlan,
          { audioBlob: audio, audioMime: encoder.mimeType, cameraBlob: null, cameraMime: null },
          {
            mediaProvider,
            container: workspaceContainer,
            getMarkdownSource: () => sourceRef.current,
            setMarkdownSource,
            bumpMediaRevision,
          },
        );
        if (signal.aborted) return;
        run.current = null;
        setState({ phase: 'done', durationSec: elapsed });
      } finally {
        if (signal.aborted) await encoder.cancel().catch(() => undefined);
      }
    })()
      .catch((error: unknown) => {
        if (signal.aborted) return;
        run.current = null;
        setState({
          phase: 'error',
          message: error instanceof Error ? error.message : 'Generating narration failed.',
        });
      })
      .finally(() => page.dispose());
  }, [bumpMediaRevision, mediaProvider, setMarkdownSource, speech, workspaceContainer]);

  const reset = useCallback(() => {
    if (!run.current) setState({ phase: 'idle' });
  }, []);

  return {
    state,
    available: Boolean(speech.synthesize && mediaProvider),
    generate,
    cancel,
    reset,
  };
}
