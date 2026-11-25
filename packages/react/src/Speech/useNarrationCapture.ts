import { useCallback, useEffect, useRef, useState } from 'react';
import {
  startDictationSession,
  type DictationSessionHandle,
  type SpeechInputProvider,
} from '@bendyline/squisq-editor-react/speech';
import {
  decodeNarrationAudio,
  MAX_NARRATION_SECONDS,
  transcribeNarrationAudio,
} from './narration-transcription.js';
import { pushMeterLevel, SILENT_METER } from './dictation-meter.js';

export function useNarrationCapture(provider: SpeechInputProvider, onText: (text: string) => void) {
  const [phase, setPhase] = useState<'idle' | 'starting' | 'recording' | 'finishing' | 'uploading'>(
    'idle',
  );
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [level, setLevel] = useState(0);
  /** Recent levels for a rolling meter, oldest first. */
  const [levels, setLevels] = useState<readonly number[]>(SILENT_METER);
  /** Phrases heard but not yet back as text. */
  const [pending, setPending] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const session = useRef<DictationSessionHandle | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestText = useRef(onText);
  latestText.current = onText;

  const release = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    session.current?.cancel();
    session.current = null;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => release, [release]);

  const quiet = () => {
    setLevel(0);
    setLevels(SILENT_METER);
  };
  const cancel = () => {
    release();
    setPhase('idle');
    quiet();
    setPending(0);
  };
  const fail = (error: unknown, run: AbortController) => {
    if (run.signal.aborted || controller.current !== run) return;
    release();
    setPhase('idle');
    quiet();
    setPending(0);
    setError(error instanceof Error ? error.message : 'Transcription failed.');
  };
  const finish = async () => {
    const run = controller.current;
    const capture = session.current;
    if (!run || !capture) return;
    setPhase('finishing');
    quiet();
    if (timer.current) clearTimeout(timer.current);
    try {
      await capture.stop();
      if (run.signal.aborted) return;
      release();
      setPhase('idle');
      setPending(0);
    } catch (error) {
      fail(error, run);
    }
  };
  const record = async () => {
    if (controller.current) return;
    const run = new AbortController();
    controller.current = run;
    setError(null);
    setPhase('starting');
    try {
      const capture = await startDictationSession({
        provider,
        signal: run.signal,
        onTranscript: (text) => {
          if (!run.signal.aborted) latestText.current(text);
        },
        onAudioLevel: (value) => {
          if (run.signal.aborted) return;
          setLevel(value);
          setLevels((previous) => pushMeterLevel(previous, value));
        },
        onPendingChange: (count) => {
          if (run.signal.aborted) return;
          setPending(count);
          if (count > 12)
            fail(new Error('Transcription cannot keep up. Try a shorter recording.'), run);
        },
        onLongPause: () => {
          void finish();
        },
        onError: (error) => fail(error, run),
      });
      if (run.signal.aborted) {
        capture.cancel();
        return;
      }
      session.current = capture;
      setPhase('recording');
      timer.current = setTimeout(() => {
        void finish();
      }, MAX_NARRATION_SECONDS * 1_000);
    } catch (error) {
      fail(error, run);
    }
  };
  const upload = async (file: File) => {
    if (controller.current) return;
    const run = new AbortController();
    controller.current = run;
    setError(null);
    setProgress(0);
    setPhase('uploading');
    try {
      const audio = await decodeNarrationAudio(file, run.signal);
      await transcribeNarrationAudio(
        audio,
        provider,
        run.signal,
        (text) => latestText.current(text),
        setProgress,
      );
      if (run.signal.aborted) return;
      release();
      setPhase('idle');
    } catch (error) {
      fail(error, run);
    }
  };
  return { phase, error, progress, level, levels, pending, record, finish, cancel, upload };
}
