/**
 * Generate narration for the open document and save it the way a recorded
 * take is saved: an audio file and v3 timing sidecar in `<doc>_files/`, plus
 * the document-anchored `{[audio … anchor=document]}` preamble line. Play mode,
 * block timing and video export then use it with no special casing.
 *
 * Audio streams straight into Squisq's encoder as each sentence arrives, so a
 * long document never sits in memory as raw float samples.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditorContext } from '@bendyline/squisq-editor-react';
import {
  buildNarrationSavePlan,
  executeNarrationSave,
} from '@bendyline/squisq-editor-react/teleprompter';
import type { DocBlocksHostSpeechAPI, SpeechSynthesisHandle } from '@bendyline/docblocks/host';
import { planSpeech } from './speakable-text.js';
import { buildTtsAlignment, spokenSpanForChunk, type SpokenSpan } from './tts-narration.js';

export type GenerateNarrationState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'generating'; readonly done: number; readonly total: number }
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
  const run = useRef<{ cancelled: boolean; handle: SpeechSynthesisHandle | null } | null>(null);

  const cancel = useCallback(() => {
    if (run.current) {
      run.current.cancelled = true;
      run.current.handle?.cancel();
      run.current = null;
    }
    setState({ phase: 'idle' });
  }, []);

  useEffect(
    () => () => {
      if (run.current) {
        run.current.cancelled = true;
        run.current.handle?.cancel();
      }
    },
    [],
  );

  const generate = useCallback(() => {
    const synthesize = speech.synthesize;
    if (!synthesize || !mediaProvider || run.current) return;
    const current = { cancelled: false, handle: null as SpeechSynthesisHandle | null };
    run.current = current;
    setState({ phase: 'generating', done: 0, total: 1 });

    void (async () => {
      const [plan, { createAudioFileEncoder }] = await Promise.all([
        planSpeech(sourceRef.current),
        import('@bendyline/squisq-video-react/encoder'),
      ]);
      if (current.cancelled) return;
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
        for (const [index, segment] of plan.segments.entries()) {
          if (current.cancelled) return;
          setState({ phase: 'generating', done: index, total: plan.segments.length });
          const handle = synthesize({ text: segment.text }, (event) => {
            if (event.kind !== 'chunk' || current.cancelled) return;
            const { chunk } = event;
            spans.push(spokenSpanForChunk(chunk, segment, elapsed));
            elapsed += chunk.durationSec;
            const samples = new Float32Array(chunk.pcm);
            appending = appending.then(() => encoder.append([samples]));
          });
          current.handle = handle;
          const result = await handle.done;
          if (current.cancelled) return;
          if (!result.ok) throw new Error(result.error.message);
        }
        await appending;
        if (current.cancelled) return;
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
        if (current.cancelled) return;
        run.current = null;
        setState({ phase: 'done', durationSec: elapsed });
      } finally {
        if (current.cancelled) await encoder.cancel().catch(() => undefined);
      }
    })().catch((error: unknown) => {
      if (current.cancelled) return;
      run.current = null;
      setState({
        phase: 'error',
        message: error instanceof Error ? error.message : 'Generating narration failed.',
      });
    });
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
