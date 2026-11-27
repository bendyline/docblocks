/**
 * Quick Jot's microphone. Loaded on its own (the shell imports Quick Jot at
 * startup), so the dictation session code is fetched only where dictation is
 * offered. Phrases arrive as text through `onText`; the box decides where
 * they go.
 */

import { useEffect, useRef } from 'react';
import type { DocBlocksHostSpeechAPI } from '@bendyline/docblocks/host';
import type { SpeechInputProvider } from '@bendyline/squisq-editor-react/speech';
import { useNarrationCapture } from '../Speech/useNarrationCapture.js';
import { useSpeechStatus } from '../Speech/useSpeechStatus.js';
import { DictateIcon } from '../icons.js';

export interface QuickJotDictationProps {
  readonly provider: SpeechInputProvider;
  readonly speech: DocBlocksHostSpeechAPI;
  /** Settings → Dictation, for a model to download or a permission to grant. */
  readonly onOpenSettings: () => void;
  /** True while the jot is being saved. */
  readonly disabled: boolean;
  readonly onText: (phrase: string) => void;
  readonly onActiveChange: (active: boolean) => void;
  /** True while phrases already heard are still being turned into text. */
  readonly onConvertingChange: (converting: boolean) => void;
  readonly onError: (message: string) => void;
}

export default function QuickJotDictation({
  provider,
  speech,
  onOpenSettings,
  disabled,
  onText,
  onActiveChange,
  onConvertingChange,
  onError,
}: QuickJotDictationProps) {
  const status = useSpeechStatus(speech);
  const capture = useNarrationCapture(provider, onText);
  const active = capture.phase !== 'idle';
  const recording = capture.phase === 'recording';
  const converting = capture.phase === 'finishing' || (recording && capture.pending > 0);
  const latest = useRef({ onActiveChange, onConvertingChange, onError });
  latest.current = { onActiveChange, onConvertingChange, onError };

  useEffect(() => {
    latest.current.onActiveChange(active);
  }, [active]);
  useEffect(() => {
    latest.current.onConvertingChange(converting);
  }, [converting]);
  // The capture stops with the button; the box must not stay locked or show dots.
  useEffect(
    () => () => {
      latest.current.onConvertingChange(false);
      latest.current.onActiveChange(false);
    },
    [],
  );
  useEffect(() => {
    if (capture.error) latest.current.onError(capture.error);
  }, [capture.error]);

  const state = status?.stt.state;
  if (state === 'unavailable') return null;
  const needsSetup = state !== undefined && state !== 'ready';
  const label = recording
    ? 'Stop dictating'
    : capture.phase === 'starting'
      ? 'Opening the microphone…'
      : active
        ? 'Finishing dictation…'
        : needsSetup
          ? 'Dictate (set up dictation first)'
          : 'Dictate';

  const click = () => {
    if (recording) void capture.finish();
    else if (capture.phase === 'starting') capture.cancel();
    else if (needsSetup) onOpenSettings();
    else void capture.record();
  };

  return (
    <button
      type="button"
      className={`db-quick-jot-btn${recording ? ' db-quick-jot-btn--recording' : ''}`}
      aria-label={label}
      title={label}
      aria-pressed={recording}
      disabled={
        status === null ||
        capture.phase === 'finishing' ||
        capture.phase === 'uploading' ||
        (disabled && !active)
      }
      onClick={click}
    >
      <DictateIcon />
      {recording && (
        <span className="db-quick-jot-meter" aria-hidden="true">
          {capture.levels.map((level, index) => (
            <span
              // Position is the identity in this fixed-length rolling buffer.
              key={index}
              className="db-quick-jot-meter-bar"
              style={{ height: `${2 + Math.round(level * 12)}px` }}
            />
          ))}
        </span>
      )}
    </button>
  );
}
