/**
 * Read a document or selection aloud through the host's synthesizer.
 *
 * Segments are synthesized one after another, ahead of playback, and streamed
 * into a single progressive player, so speech starts while later sections are
 * still being generated. `AutoPlayGate` decides when enough is buffered to
 * play through without stalling. Previous and next move along that timeline;
 * a skip past what has been synthesized starts synthesis over from there.
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
      /** The listener has not paused, though audio may be catching up. */
      readonly playing: boolean;
      /** Playing, but stopped to wait for synthesis. */
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
  /** Back to the start of this segment, or to the previous one near its start. */
  previous(): void;
  next(): void;
  stop(): void;
}

/** Past this far into a segment, previous restarts it rather than going back. */
const RESTART_SEGMENT_SECONDS = 2;

/**
 * How often a session follows the playhead and re-asks the gate. The player
 * reports only events — chunks, play, pause, seek — not playback moving on.
 */
const POLL_MS = 250;

/** The engine synthesizes, and delivers, a sentence at a time. */
const SENTENCE_BREAK = /(?<=[.!?…])\s+/u;

interface Session {
  readonly player: ProgressivePlayer;
  readonly gate: AutoPlayGate;
  segments: readonly SpeechSegmentPlan[];
  /** Bumped when synthesis starts over from a new segment; older runs stop. */
  run: number;
  /** The segment the current timeline starts with. */
  firstSegment: number;
  /** The segment being synthesized, or null once the rest is synthesized. */
  synthesizing: number | null;
  /** How far into that segment's text synthesis has delivered audio. */
  synthesizedThrough: number;
  /** Follows the playhead and re-asks the gate while playback waits. */
  poll: ReturnType<typeof setInterval> | null;
  /** Timeline seconds where each synthesized segment starts. */
  readonly segmentStarts: Map<number, number>;
  /** Segment of each appended chunk, by chunk index. */
  readonly chunkSegments: number[];
  handle: SpeechSynthesisHandle | null;
  /** Playback has begun at least once; until then the voice is still loading. */
  started: boolean;
  cancelled: boolean;
  userPaused: boolean;
}

/** Character counts of the sentences still to synthesize, in order. */
function* upcomingSentences(
  segments: readonly SpeechSegmentPlan[],
  segment: number,
  offset: number,
): Generator<number> {
  for (let index = segment; index < segments.length; index += 1) {
    const text = segments[index]?.text ?? '';
    for (const sentence of (index === segment ? text.slice(offset) : text).split(SENTENCE_BREAK)) {
      const length = sentence.trim().length;
      if (length > 0) yield length;
    }
  }
}

/** Start playback once the gate predicts it can run on without stalling. */
function playIfReady(current: Session): void {
  if (current.cancelled || current.userPaused || current.synthesizing === null) return;
  const snapshot = current.player.snapshot();
  if (snapshot.isPlaying) return;
  const ready = current.gate.ready(
    snapshot.bufferedDuration - snapshot.currentTime,
    upcomingSentences(current.segments, current.synthesizing, current.synthesizedThrough),
    performance.now(),
  );
  if (ready) void current.player.play();
}

function endSession(current: Session): void {
  current.cancelled = true;
  current.handle?.cancel();
  if (current.poll) clearInterval(current.poll);
  current.player.dispose();
}

function sameState(a: ReadAloudState, b: ReadAloudState): boolean {
  if (a.phase === 'reading' && b.phase === 'reading') {
    return (
      a.playing === b.playing &&
      a.waiting === b.waiting &&
      a.segment === b.segment &&
      a.segments === b.segments
    );
  }
  return a.phase === b.phase && a.phase !== 'error';
}

function segmentAt(current: Session, snapshot: ProgressivePlayerSnapshot): number {
  const caughtUp = !snapshot.isPlaying && snapshot.currentTime >= snapshot.bufferedDuration - 0.05;
  // Waiting at the end of the timeline: what comes next is what is being made.
  if (caughtUp && current.synthesizing !== null) return current.synthesizing;
  if (snapshot.currentChunk === null) return current.firstSegment;
  return current.chunkSegments[snapshot.currentChunk] ?? current.firstSegment;
}

export function useReadAloud(speech: DocBlocksHostSpeechAPI | undefined): ReadAloud {
  const [state, setState] = useState<ReadAloudState>({ phase: 'idle' });
  const session = useRef<Session | null>(null);

  const stop = useCallback(() => {
    const current = session.current;
    session.current = null;
    if (current) endSession(current);
    setState({ phase: 'idle' });
  }, []);

  useEffect(() => stop, [stop]);

  const fail = useCallback(
    (message: string) => {
      stop();
      setState({ phase: 'error', message });
    },
    [stop],
  );

  const refresh = useCallback(() => {
    const current = session.current;
    if (!current) return;
    const snapshot = current.player.snapshot();
    if (
      snapshot.complete &&
      !snapshot.isPlaying &&
      snapshot.currentTime >= snapshot.bufferedDuration - 0.05
    ) {
      // Finished speaking.
      session.current = null;
      endSession(current);
      setState({ phase: 'idle' });
      return;
    }
    if (snapshot.isPlaying) current.started = true;
    const next: ReadAloudState = current.started
      ? {
          phase: 'reading',
          playing: !current.userPaused,
          waiting: !current.userPaused && !snapshot.isPlaying,
          segment: segmentAt(current, snapshot),
          segments: current.segments.length,
        }
      : { phase: 'loading' };
    // Polled while playing, so keep the old state when nothing visible changed.
    setState((previous) => (sameState(previous, next) ? previous : next));
  }, []);

  /** Synthesize from `first` to the end into a fresh timeline. */
  const synthesizeFrom = useCallback(
    async (current: Session, first: number, synthesize: DocBlocksHostSpeechAPI['synthesize']) => {
      if (!synthesize) return;
      current.run += 1;
      const run = current.run;
      const stale = () => current.cancelled || current.run !== run;
      current.handle?.cancel();
      current.handle = null;
      current.firstSegment = first;
      current.synthesizing = first;
      current.segmentStarts.clear();
      current.chunkSegments.length = 0;
      current.gate.restart();
      const { player, gate, segments } = current;
      player.reset();
      let chunkIndex = 0;
      for (let index = first; index < segments.length; index += 1) {
        if (stale()) return;
        current.synthesizing = index;
        current.synthesizedThrough = 0;
        const handle = synthesize({ text: segments[index]?.text ?? '' }, (event) => {
          if (stale() || event.kind !== 'chunk') return;
          const { chunk } = event;
          if (!current.segmentStarts.has(index)) {
            current.segmentStarts.set(index, player.snapshot().bufferedDuration);
          }
          current.chunkSegments[chunkIndex] = index;
          player.append({ ...chunk, index: chunkIndex });
          chunkIndex += 1;
          gate.record(
            chunk.textEnd - current.synthesizedThrough,
            chunk.durationSec,
            performance.now(),
          );
          current.synthesizedThrough = chunk.textEnd;
          playIfReady(current);
        });
        current.handle = handle;
        const result = await handle.done;
        if (stale()) return;
        if (!result.ok) {
          fail(result.error.message);
          return;
        }
      }
      current.handle = null;
      current.synthesizing = null;
      player.finish();
      if (!player.snapshot().isPlaying && !current.userPaused) void player.play();
    },
    [fail],
  );

  const start = useCallback(
    (markdown: string) => {
      const synthesize = speech?.synthesize;
      if (!synthesize) return;
      stop();
      const player = ProgressivePlayer.create(() => {
        if (session.current?.player === player) refresh();
      });
      if (!player) {
        setState({ phase: 'error', message: 'Audio playback is not available.' });
        return;
      }
      player.prime();
      const current: Session = {
        player,
        gate: new AutoPlayGate(),
        segments: [],
        run: 0,
        firstSegment: 0,
        synthesizing: null,
        synthesizedThrough: 0,
        poll: null,
        segmentStarts: new Map(),
        chunkSegments: [],
        handle: null,
        started: false,
        cancelled: false,
        userPaused: false,
      };
      current.poll = setInterval(() => {
        playIfReady(current);
        if (session.current === current) refresh();
      }, POLL_MS);
      session.current = current;
      setState({ phase: 'loading' });

      void (async () => {
        const plan = await planSpeech(markdown);
        if (current.cancelled) return;
        current.segments = plan.segments;
        if (plan.segments.length === 0) {
          fail('There is nothing to read aloud.');
          return;
        }
        await synthesizeFrom(current, 0, synthesize);
      })().catch((error: unknown) => {
        if (current.cancelled) return;
        fail(error instanceof Error ? error.message : 'Reading aloud failed.');
      });
    },
    [speech, stop, fail, refresh, synthesizeFrom],
  );

  const pause = useCallback(() => {
    const current = session.current;
    if (!current) return;
    current.userPaused = true;
    current.player.pause();
    refresh();
  }, [refresh]);

  const resume = useCallback(() => {
    const current = session.current;
    if (!current) return;
    current.userPaused = false;
    current.player.prime();
    void current.player.play();
    refresh();
  }, [refresh]);

  const skip = useCallback(
    (direction: -1 | 1) => {
      const current = session.current;
      if (!current || current.segments.length === 0) return;
      current.player.prime();
      const snapshot = current.player.snapshot();
      const segment = segmentAt(current, snapshot);
      const segmentStart = current.segmentStarts.get(segment);
      const restart =
        direction < 0 &&
        segmentStart !== undefined &&
        snapshot.currentTime - segmentStart > RESTART_SEGMENT_SECONDS;
      const target = restart ? segment : segment + direction;
      if (target < 0 || target >= current.segments.length) {
        if (target < 0 && segmentStart !== undefined) current.player.seek(segmentStart);
        refresh();
        return;
      }
      const start = current.segmentStarts.get(target);
      if (start !== undefined) {
        current.player.seek(start);
      } else if (target === current.synthesizing) {
        // Its first sentence is still being made: wait where it will begin.
        current.player.seek(snapshot.bufferedDuration);
      } else {
        // Outside this timeline: synthesize again from the target.
        void synthesizeFrom(current, target, speech?.synthesize).catch((error: unknown) => {
          if (current.cancelled) return;
          fail(error instanceof Error ? error.message : 'Reading aloud failed.');
        });
      }
      refresh();
    },
    [speech, fail, refresh, synthesizeFrom],
  );

  const previous = useCallback(() => skip(-1), [skip]);
  const next = useCallback(() => skip(1), [skip]);

  return { state, start, pause, resume, previous, next, stop };
}
