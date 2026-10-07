/**
 * Export the document as an audio file: its narration track when it has one,
 * otherwise read aloud with the narration voice.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { useEditorContext } from '@bendyline/squisq-editor-react';
import type { DocBlocksHostSpeechAPI } from '@bendyline/docblocks/host';
import type { AudioFileFormat } from '@bendyline/squisq-video-react/encoder';
import type { ContentContainer } from '@bendyline/squisq/storage';
import { Dialog } from '../components/Dialog.js';
import {
  AUDIO_FORMAT_LABELS,
  audioExportFilename,
  exportNarrationAudio,
  exportSpokenAudio,
} from './export-audio.js';
import { hasDocumentNarration } from './useGenerateNarration.js';

export interface AudioExportDialogProps {
  speech: DocBlocksHostSpeechAPI | undefined;
  selectedFile: string | null;
  workspaceContainer: ContentContainer | null;
  /** Save through the host's export destination flow; false when the person cancelled. */
  onSave: (blob: Blob, filename: string) => Promise<boolean>;
  onClose: () => void;
}

type ExportState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'working'; readonly message: string; readonly progress: number | null }
  | { readonly phase: 'done'; readonly filename: string }
  | { readonly phase: 'error'; readonly message: string };

export function AudioExportDialog({
  speech,
  selectedFile,
  workspaceContainer,
  onSave,
  onClose,
}: AudioExportDialogProps) {
  const { markdownSource, mediaProvider, mediaEditRenders } = useEditorContext();
  const [formats, setFormats] = useState<readonly AudioFileFormat[]>([]);
  const [format, setFormat] = useState<AudioFileFormat>('wav');
  const [state, setState] = useState<ExportState>({ phase: 'idle' });
  const abort = useRef<AbortController | null>(null);
  const formatId = useId();
  const narrated = hasDocumentNarration(markdownSource);
  const canSpeak = Boolean(speech?.synthesize);

  useEffect(() => {
    let live = true;
    void import('@bendyline/squisq-video-react/encoder')
      .then(({ supportedAudioFileFormats }) => supportedAudioFileFormats())
      .then((supported) => {
        if (!live) return;
        setFormats(supported);
        // Prefer the most widely playable compressed format available here.
        setFormat(supported.includes('m4a') ? 'm4a' : (supported[0] ?? 'wav'));
      });
    return () => {
      live = false;
      abort.current?.abort();
    };
  }, []);

  const busy = state.phase === 'working';

  const run = async () => {
    const controller = new AbortController();
    abort.current = controller;
    try {
      let result: { blob: Blob; extension: string } | null;
      if (narrated && mediaProvider) {
        setState({ phase: 'working', message: 'Mixing the narration…', progress: null });
        result = await exportNarrationAudio({
          markdown: markdownSource,
          fileName: selectedFile,
          workspaceContainer,
          mediaProvider,
          ...(mediaEditRenders
            ? { processedAudio: (clip) => mediaEditRenders.processedAudio(clip) }
            : {}),
          format,
          signal: controller.signal,
        });
        if (!result) throw new Error('This document has no audio to export.');
      } else {
        if (!speech) throw new Error('Narration is not available.');
        result = await exportSpokenAudio({
          markdown: markdownSource,
          speech,
          format,
          signal: controller.signal,
          onProgress: (done, total) =>
            setState({
              phase: 'working',
              message: `Reading part ${Math.min(done + 1, total)} of ${total}…`,
              progress: total > 0 ? done / total : null,
            }),
        });
      }
      if (controller.signal.aborted) return;
      const filename = audioExportFilename(selectedFile, result.extension);
      setState({ phase: 'working', message: 'Saving…', progress: null });
      if (!(await onSave(result.blob, filename))) {
        setState({ phase: 'idle' });
        return;
      }
      setState({ phase: 'done', filename });
    } catch (error) {
      if (controller.signal.aborted) {
        setState({ phase: 'idle' });
        return;
      }
      setState({
        phase: 'error',
        message: error instanceof Error ? error.message : 'Audio export failed.',
      });
    } finally {
      if (abort.current === controller) abort.current = null;
    }
  };

  const close = () => {
    abort.current?.abort();
    onClose();
  };

  return (
    <Dialog
      title="Export audio"
      onClose={close}
      closeOnBackdrop={!busy}
      footer={
        state.phase === 'done' ? (
          <button type="button" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button type="button" onClick={close}>
              {busy ? 'Stop' : 'Cancel'}
            </button>
            <button
              type="button"
              disabled={busy || formats.length === 0 || (!narrated && !canSpeak)}
              onClick={() => void run()}
            >
              Export
            </button>
          </>
        )
      }
    >
      {state.phase === 'done' ? (
        <p role="status">Saved {state.filename}.</p>
      ) : (
        <>
          <p>
            {narrated
              ? 'Exports the document’s narration track, mixed with its other audio, exactly as Play mode plays it.'
              : canSpeak
                ? 'This document has no narration track, so DocBlocks reads it aloud with your narration voice.'
                : 'This document has no narration track. Download the narration voices in Settings to export it as speech.'}
          </p>
          <label className="db-settings-select" htmlFor={formatId}>
            <span className="db-settings-select-header">Format</span>
            <select
              id={formatId}
              className="db-settings-select-input"
              value={format}
              disabled={busy}
              onChange={(event) => setFormat(event.currentTarget.value as AudioFileFormat)}
            >
              {formats.map((option) => (
                <option key={option} value={option}>
                  {AUDIO_FORMAT_LABELS[option]}
                </option>
              ))}
            </select>
          </label>
          {state.phase === 'working' && (
            <div className="db-settings-ai-download-progress" role="status">
              <progress
                max={1}
                value={state.progress ?? undefined}
                aria-label="Audio export progress"
              />
              <span>{state.message}</span>
            </div>
          )}
          {state.phase === 'error' && (
            <p className="db-settings-ai-error" role="alert">
              {state.message}
            </p>
          )}
        </>
      )}
    </Dialog>
  );
}
