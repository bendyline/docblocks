import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEditorContext, useEditorInsertMenuItems } from '@bendyline/squisq-editor-react';
import type { DocBlocksHostAiAPI, DocBlocksHostSpeechAPI } from '@bendyline/docblocks/host';
import { Dialog } from '../components/Dialog.js';
import { createSpeechInputProvider } from './speech-input-provider.js';
import { useSpeechStatus } from './useSpeechStatus.js';
import { useNarrationCapture } from './useNarrationCapture.js';
import {
  cleanNarrationText,
  MAX_NARRATION_CHARACTERS,
  narrationAsMarkdown,
} from './narration-text.js';
import { NarrationRewriteAction } from './NarrationRewriteAction.js';

interface Props {
  speech: DocBlocksHostSpeechAPI;
  ai?: DocBlocksHostAiAPI;
  allowRecording: boolean;
  readOnly: boolean;
  onOpenSettings: () => void;
}

/** Mounted in the toolbar slot for the lifetime of this document's editor. */
export function TextFromNarration(props: Props) {
  const { editorMode, dictation } = useEditorContext();
  const [open, setOpen] = useState(false);
  useEditorInsertMenuItems(
    !props.readOnly && editorMode === 'markdown'
      ? [
          {
            id: 'docblocks-text-from-narration',
            label: 'Text from narration',
            icon: <span aria-hidden="true">Aa</span>,
            disabled: dictation?.active ?? false,
            onSelect: () => setOpen(true),
          },
        ]
      : [],
  );
  return open && !props.readOnly ? (
    <TextFromNarrationDialog {...props} onClose={() => setOpen(false)} />
  ) : null;
}

export function TextFromNarrationDialog({
  speech,
  ai,
  allowRecording,
  onOpenSettings,
  onClose,
}: Props & { onClose: () => void }) {
  const { insertBlockAfterCursor, markdownSource } = useEditorContext();
  const status = useSpeechStatus(speech);
  const provider = useMemo(
    () => createSpeechInputProvider(speech, { onRequestSetup: onOpenSettings }),
    [speech, onOpenSettings],
  );
  const [text, setText] = useState('');
  const [undo, setUndo] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rewriting, setRewriting] = useState(false);
  const initialSource = useRef(markdownSource);
  const fileInput = useRef<HTMLInputElement>(null);
  const transcript = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef('');
  const setDraft = (value: string) => {
    textRef.current = value;
    setText(value);
  };
  const capture = useNarrationCapture(provider, (fragment) => {
    const next = `${textRef.current}${textRef.current.trim() ? ' ' : ''}${fragment.trim()}`;
    if (next.length > MAX_NARRATION_CHARACTERS) {
      capture.cancel();
      setNotice(
        'The transcript reached its size limit. Insert this text, then start another recording.',
      );
      return;
    }
    setUndo(null);
    setDraft(next);
  });
  const busy = capture.phase !== 'idle' || rewriting;
  const ready = Boolean(speech.transcribe) && status?.stt.state === 'ready';
  useEffect(() => {
    if (capture.phase !== 'idle' && transcript.current) {
      transcript.current.scrollTop = transcript.current.scrollHeight;
    }
  }, [text, capture.phase]);
  const replace = (next: string) => {
    setUndo(textRef.current);
    setDraft(next);
  };
  const close = () => {
    capture.cancel();
    onClose();
  };
  const insert = () => {
    if (busy || !text.trim()) return;
    if (markdownSource !== initialSource.current) {
      setNotice(
        'The document changed while this dialog was open. Copy your transcript, close the dialog, and choose the insertion point again.',
      );
      return;
    }
    if (!insertBlockAfterCursor(narrationAsMarkdown(text))) {
      setNotice('Switch to Write or Source view in the Document layout to insert this text.');
      return;
    }
    close();
  };
  return createPortal(
    <Dialog
      title="Text from narration"
      size="wide"
      className="db-text-from-narration"
      onClose={close}
      closeOnBackdrop={false}
      footer={
        <>
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button type="button" disabled={busy || !text.trim()} onClick={insert}>
            Insert text
          </button>
        </>
      }
    >
      <p>
        Record your voice or upload audio. Review and edit the transcript before adding it to your
        document.
      </p>
      <div className="db-narration-actions">
        {capture.phase === 'recording' ? (
          <button type="button" onClick={() => void capture.finish()}>
            Stop recording
          </button>
        ) : (
          <button
            type="button"
            disabled={!allowRecording || !ready || busy}
            onClick={() => void capture.record()}
          >
            Record
          </button>
        )}
        <button type="button" disabled={!ready || busy} onClick={() => fileInput.current?.click()}>
          Upload audio
        </button>
        {capture.phase !== 'idle' && capture.phase !== 'recording' && (
          <button type="button" onClick={capture.cancel}>
            Stop transcription
          </button>
        )}
        <input
          ref={fileInput}
          type="file"
          hidden
          accept="audio/*,.wav,.mp3,.m4a,.ogg,.webm,.flac"
          aria-label="Upload audio file"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) void capture.upload(file);
          }}
        />
      </div>
      <p className="db-narration-note">
        Audio stays on this computer. Limit: 10 minutes; uploads up to 25 MB.
      </p>
      {!allowRecording && (
        <p className="db-narration-note">
          Microphone recording is disabled. You can still upload audio.
        </p>
      )}
      {!ready && (
        <div role="status">
          <p>
            {status?.stt.reason ??
              (status
                ? 'Download a dictation model in Settings to transcribe audio.'
                : 'Checking speech recognition…')}
          </p>
          <button
            type="button"
            onClick={() => {
              close();
              onOpenSettings();
            }}
          >
            Speech settings
          </button>
        </div>
      )}
      {capture.phase !== 'idle' && (
        <div role="status" className="db-narration-status">
          {capture.phase === 'recording'
            ? 'Listening — the transcript updates as phrases are recognized…'
            : capture.phase === 'starting'
              ? 'Opening microphone…'
              : capture.phase === 'finishing'
                ? 'Finishing transcription…'
                : `Transcribing audio… ${capture.progress}%`}
          {capture.phase === 'recording' && (
            <meter min={0} max={1} value={capture.level} aria-label="Microphone level" />
          )}
        </div>
      )}
      <label className="db-narration-transcript">
        <span>Transcript</span>
        <textarea
          ref={transcript}
          value={text}
          rows={7}
          maxLength={MAX_NARRATION_CHARACTERS}
          readOnly={busy}
          onChange={(event) => setDraft(event.currentTarget.value)}
          placeholder="Your words will appear here…"
        />
      </label>
      <div className="db-narration-actions">
        <button
          type="button"
          disabled={busy || !text.trim()}
          onClick={() => replace(cleanNarrationText(text))}
        >
          Clean up fillers
        </button>
        <button
          type="button"
          disabled={busy || undo === null}
          onClick={() => {
            if (undo !== null) {
              setDraft(undo);
              setUndo(null);
            }
          }}
        >
          Undo cleanup
        </button>
      </div>
      <p className="db-narration-note">
        Removes “um”, “uh”, “ah”, accidental repeated words, ellipsis pauses (… or ...), and
        transcript cues such as [Pause] and [Inaudible conversations]. Review before inserting.
      </p>
      {ai && (
        <NarrationRewriteAction
          ai={ai}
          text={text}
          disabled={capture.phase !== 'idle'}
          onRewrite={replace}
          onBusy={setRewriting}
        />
      )}
      {capture.error && (
        <p className="db-settings-ai-error" role="alert">
          {capture.error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </Dialog>,
    document.body,
  );
}
