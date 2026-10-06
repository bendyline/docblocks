/**
 * "Generate narration": synthesize the whole document and save it as the
 * document's narration track, replacing any existing one after confirmation.
 */

import { useEditorContext } from '@bendyline/squisq-editor-react';
import type { DocBlocksHostSpeechAPI } from '@bendyline/docblocks/host';
import { Dialog } from '../components/Dialog.js';
import { hasDocumentNarration, useGenerateNarration } from './useGenerateNarration.js';

export interface GenerateNarrationDialogProps {
  speech: DocBlocksHostSpeechAPI;
  onClose: () => void;
}

function formatDuration(seconds: number): string {
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return minutes > 0 ? `${minutes} min ${rest} s` : `${rest} s`;
}

export function GenerateNarrationDialog({ speech, onClose }: GenerateNarrationDialogProps) {
  const { markdownSource } = useEditorContext();
  const narration = useGenerateNarration(speech);
  const { state } = narration;
  const busy = state.phase === 'generating' || state.phase === 'saving';
  const replacing = hasDocumentNarration(markdownSource);

  const close = () => {
    if (busy) narration.cancel();
    onClose();
  };

  return (
    <Dialog
      title="Generate narration"
      onClose={close}
      closeOnBackdrop={!busy}
      className="db-speech-narration-dialog"
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
              disabled={busy || !narration.available}
              onClick={() => narration.generate()}
            >
              {replacing ? 'Replace narration' : 'Generate'}
            </button>
          </>
        )
      }
    >
      {state.phase === 'done' ? (
        <p role="status">
          Added {formatDuration(state.durationSec)} of narration. Play mode and video export now
          follow it, section by section.
        </p>
      ) : (
        <>
          <p className="db-speech-narration-intro">
            DocBlocks reads the document aloud with your narration voice and saves the audio beside
            it, timed to each section. Change the voice and speed in Settings.
          </p>
          {replacing && (
            <p className="db-speech-narration-warning" role="note">
              This document already has narration. Generating replaces it; the old audio file stays
              in the document’s folder.
            </p>
          )}
          {state.phase === 'generating' && (
            <div className="db-settings-ai-download-progress" role="status">
              <progress max={state.total} value={state.done} aria-label="Narration progress" />
              <span>
                Generating part {Math.min(state.done + 1, state.total)} of {state.total}…
              </span>
            </div>
          )}
          {state.phase === 'saving' && <p role="status">Saving the narration…</p>}
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
