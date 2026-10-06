/**
 * Read a document or selection aloud through the host's synthesizer.
 *
 * Segments are synthesized one after another and streamed into a single
 * progressive player, so speech starts while later sections are still being
 * generated. Gezel's auto-play rule decides when enough is buffered.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DocBlocksHostSpeechAPI, SpeechSynthesisHandle } from '@bendyline/docblocks/host';
import {
  AutoPlayGate,
  ProgressivePlayer,
  type ProgressivePlayerSnapshot,
} from './progressive-player.js';
import { planSpeech, type SpeechSegmentPlan } from './speakable-text.js';

export type ReadAloudState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'loading' }
  | {
      readonly phase: 'reading';
      readonly playing: boolean;
      readonly waiting: boolean;
      /** Index into `segments` of the one being heard. */
      readonly segment: number;
      readonly segments: number;
    }
  | { readonly phase: 'error'; readonly message: string };

export interface ReadAloud {
  readonly state: ReadAloudState;
  /** Call from the click handler: audio permission is granted per gesture. */
  start(markdown: string): void;
  pause(): void;
  resume(): void;
  stop(): void;
}

interface Session {
  readonly player: ProgressivePlayer;
  readonly chunkSegments: number[];
  segments: readonly SpeechSegmentPlan[];
  handle: SpeechSynthesisHandle | null;
  cancelled: boolean;
  userPaused: boolean;
}

export function useReadAloud(speech: DocBlocksHostSpeechAPI | undefined): ReadAloud {
  const [state, setState] = useState<ReadAloudState>({ phase: 'idle' });
  const session = useRef<Session | null>(null);

  const stop = useCallback(() => {
    const current = session.current;
    session.current = null;
    if (current) {
      current.cancelled = true;
      current.handle?.cancel();
      current.player.dispose();
    }
    setState({ phase: 'idle' });
  }, []);

  useEffect(() => stop, [stop]);

  const start = useCallback(
    (markdown: string) => {
      const synthesize = speech?.synthesize;
      if (!synthesize) return;
      stop();
      const onChange = (snapshot: ProgressivePlayerSnapshot) => {
        const current = session.current;
        if (!current || current.player !== player) return;
        if (
          snapshot.complete &&
          !snapshot.isPlaying &&
          snapshot.currentTime >= snapshot.bufferedDuration - 0.05
        ) {
          // Finished speaking.
          session.current = null;
          player.dispose();
          setState({ phase: 'idle' });
          return;
        }
        const segment =
          snapshot.currentChunk === null ? 0 : (current.chunkSegments[snapshot.currentChunk] ?? 0);
        setState({
          phase: 'reading',
          playing: snapshot.isPlaying,
          waiting: snapshot.waitingForAudio,
          segment,
          segments: current.segments.length,
        });
      };
      const player = ProgressivePlayer.create(onChange);
      if (!player) {
        setState({ phase: 'error', message: 'Audio playback is not available.' });
        return;
      }
      player.prime();
      const current: Session = {
        player,
        chunkSegments: [],
        segments: [],
        handle: null,
        cancelled: false,
        userPaused: false,
      };
      session.current = current;
      setState({ phase: 'loading' });

      void (async () => {
        const plan = await planSpeech(markdown);
        if (current.cancelled) return;
        current.segments = plan.segments;
        if (plan.segments.length === 0) {
          stop();
          setState({ phase: 'error', message: 'There is nothing to read aloud.' });
          return;
        }
        const totalCharacters = plan.segments.reduce((sum, s) => sum + s.text.length, 0);
        const gate = new AutoPlayGate();
        let spokenCharacters = 0;
        let chunkIndex = 0;
        for (const [segmentIndex, segment] of plan.segments.entries()) {
          if (current.cancelled) return;
          const handle = synthesize({ text: segment.text }, (event) => {
            if (current.cancelled || event.kind !== 'chunk') return;
            current.chunkSegments[chunkIndex] = segmentIndex;
            player.append({ ...event.chunk, index: chunkIndex });
            chunkIndex += 1;
            const snapshot = player.snapshot();
            const progress = {
              completedCharacters: spokenCharacters + event.chunk.textEnd,
              totalCharacters,
            };
            if (
              !snapshot.isPlaying &&
              !current.userPaused &&
              gate.ready(snapshot, progress, performance.now())
            ) {
              void player.play();
            }
          });
          current.handle = handle;
          const result = await handle.done;
          if (current.cancelled) return;
          if (!result.ok) {
            stop();
            setState({ phase: 'error', message: result.error.message });
            return;
          }
          spokenCharacters += segment.text.length;
        }
        current.handle = null;
        player.finish();
        if (!player.snapshot().isPlaying && !current.userPaused) void player.play();
      })().catch((error: unknown) => {
        if (current.cancelled) return;
        stop();
        setState({
          phase: 'error',
          message: error instanceof Error ? error.message : 'Reading aloud failed.',
        });
      });
    },
    [speech, stop],
  );

  const pause = useCallback(() => {
    const current = session.current;
    if (!current) return;
    current.userPaused = true;
    current.player.pause();
  }, []);

  const resume = useCallback(() => {
    const current = session.current;
    if (!current) return;
    current.userPaused = false;
    void current.player.play();
  }, []);

  return { state, start, pause, resume, stop };
}
