import { expect } from 'chai';
import type {
  DocBlocksHostSpeechAPI,
  SpeechReadiness,
  SpeechResult,
  SpeechSynthesisSummary,
  SpeechSynthesizeEvent,
  SpeechSynthesizeRequest,
} from '@bendyline/docblocks/host';
import {
  AutoPlayGate,
  ProgressivePlayer,
  type PlayerAudioContext,
  type ProgressivePlayerSnapshot,
} from '../src/Speech/progressive-player.js';
import {
  createSpeechInputProvider,
  stripNonSpeechCues,
  stripPauseEllipses,
} from '../src/Speech/speech-input-provider.js';
import { useReadAloud, type ReadAloudState } from '../src/Speech/useReadAloud.js';
import { act, advanceTime, renderHook } from './helpers/renderHook.js';

/** Just enough AudioContext for the player: buffers have a duration, time is settable. */
class FakeAudioContext {
  /** The context the code under test created most recently. */
  static latest: FakeAudioContext | null = null;
  constructor() {
    FakeAudioContext.latest = this;
  }
  currentTime = 0;
  readonly destination = {} as AudioDestinationNode;
  readonly started: Array<{ when: number; offset: number; duration: number }> = [];
  createBuffer(_channels: number, length: number, sampleRate: number): AudioBuffer {
    return {
      duration: length / sampleRate,
      copyToChannel: () => undefined,
    } as unknown as AudioBuffer;
  }
  createBufferSource(): AudioBufferSourceNode {
    const node = {
      buffer: null as AudioBuffer | null,
      connect: () => undefined,
      addEventListener: () => undefined,
      start: (when: number, offset: number) =>
        this.started.push({ when, offset, duration: node.buffer?.duration ?? 0 }),
      stop: () => undefined,
    };
    return node as unknown as AudioBufferSourceNode;
  }
  async resume(): Promise<void> {}
  async close(): Promise<void> {}
}

const second = (index: number, seconds = 1) => ({
  index,
  pcm: new Float32Array(Math.round(24_000 * seconds)).buffer,
  sampleRate: 24_000,
});

describe('ProgressivePlayer', () => {
  it('waits for missing chunks and tracks the chunk under the playhead', async () => {
    const context = new FakeAudioContext();
    const snapshots: ProgressivePlayerSnapshot[] = [];
    const player = new ProgressivePlayer(context as unknown as PlayerAudioContext, (s) =>
      snapshots.push(s),
    );
    player.append(second(1));
    expect(player.snapshot().bufferedDuration).to.equal(0);
    player.append(second(0));
    expect(player.snapshot().bufferedDuration).to.equal(2);
    expect(await player.play()).to.equal(true);
    expect(context.started.map((s) => s.duration)).to.deep.equal([1, 1]);
    context.currentTime = 1.5;
    expect(player.snapshot().currentChunk).to.equal(1);
    player.pause();
    expect(player.snapshot().isPlaying).to.equal(false);
    player.dispose();
  });

  it('reports waiting when playback catches up with synthesis', async () => {
    const context = new FakeAudioContext();
    const player = new ProgressivePlayer(context as unknown as PlayerAudioContext, () => undefined);
    player.append(second(0));
    player.seek(1);
    expect(player.snapshot().waitingForAudio).to.equal(true);
    player.finish();
    expect(player.snapshot().waitingForAudio).to.equal(false);
    player.dispose();
  });
});

describe('ProgressivePlayer.reset', () => {
  it('empties the timeline so a new one can start from zero', async () => {
    const context = new FakeAudioContext();
    const player = new ProgressivePlayer(context as unknown as PlayerAudioContext, () => undefined);
    player.append(second(0));
    player.finish();
    expect(await player.play()).to.equal(true);
    player.reset();
    expect(player.snapshot()).to.include({
      bufferedDuration: 0,
      currentTime: 0,
      isPlaying: false,
      complete: false,
      currentChunk: null,
    });
    // Indexes restart too: chunk 0 of the new timeline is accepted.
    player.append(second(0, 2));
    expect(player.snapshot().bufferedDuration).to.equal(2);
    player.dispose();
  });
});

describe('AutoPlayGate', () => {
  // Kokoro on a laptop CPU: about 16 characters a second of speech, made at
  // about 1.3× realtime, a whole sentence at a time.
  const SECONDS_PER_CHARACTER = 1 / 16;
  /** A gate that has timed one 32-character sentence; `at` is when it arrived. */
  function measured(realtime: number): { gate: AutoPlayGate; at: number } {
    const gate = new AutoPlayGate();
    const characters = 32;
    const audio = characters * SECONDS_PER_CHARACTER;
    const at = (audio / realtime) * 1000;
    gate.record(characters, audio, 0);
    gate.record(characters, audio, at);
    return { gate, at };
  }

  it('waits until there is a rate to predict with', () => {
    const gate = new AutoPlayGate();
    gate.record(40, 2.5, 0);
    expect(gate.ready(30, [20], 10_000)).to.equal(false);
  });

  it('opens quickly when short sentences follow fast synthesis', () => {
    const { gate, at } = measured(3);
    expect(gate.ready(3, [30, 30, 30, 30], at)).to.equal(true);
  });

  it('holds a few seconds of buffer when a long sentence is next', () => {
    const { gate, at } = measured(1.3);
    // 150 characters at 1.3× realtime: about 7 s before it exists.
    expect(gate.ready(4, [150, 40], at)).to.equal(false);
    expect(gate.ready(9, [150, 40], at)).to.equal(true);
  });

  it('counts the progress of the sentence being synthesized while it waits', () => {
    const { gate, at } = measured(1.3);
    expect(gate.ready(4, [150, 40], at)).to.equal(false);
    // Six seconds on, the long sentence is about 1 s from done.
    expect(gate.ready(4, [150, 40], at + 6_000)).to.equal(true);
  });

  it('only looks a minute ahead when synthesis is slower than speech', () => {
    const { gate, at } = measured(0.8);
    const book = Array.from({ length: 500 }, () => 80);
    // The whole book would need ten minutes of buffer; a minute ahead needs about 20 s.
    expect(gate.ready(25, book, at)).to.equal(true);
    expect(gate.ready(15, book, at)).to.equal(false);
  });

  it('does not count the gap after a restart as synthesis time', () => {
    const { gate } = measured(3);
    gate.restart();
    // A minute later the next chunk lands; without restart that would read as 0.04× realtime.
    gate.record(32, 2, 60_000);
    expect(gate.ready(3, [30, 30], 60_000)).to.equal(true);
  });
});

describe('speech input provider', () => {
  function fakeSpeech(stt: SpeechReadiness, transcribeOk = true): DocBlocksHostSpeechAPI {
    return {
      status: async () => ({ stt, tts: { state: 'unavailable' } }),
      onStatus: () => () => undefined,
      catalog: async () => ({ ok: true, value: { models: [], voices: [] } }),
      installModel: () => ({ done: new Promise(() => undefined), cancel: () => undefined }),
      removeModel: async () => ({ ok: true, value: null }),
      getPreferences: async () => ({ sttModel: null, voice: null, speed: 1 }),
      setPreferences: async () => ({ sttModel: null, voice: null, speed: 1 }),
      prepare: async () => ({ ok: true, value: null }),
      transcribe: async (request) =>
        transcribeOk
          ? {
              ok: true,
              value: {
                text: `heard ${request.prompt ?? ''}`.trim(),
                language: 'en',
                segments: request.timestamps
                  ? [
                      {
                        start: 0.5,
                        end: 0.9,
                        text: 'heard...',
                        words: [{ start: 0.5, end: 0.9, text: 'heard...' }],
                      },
                    ]
                  : [],
                durationMs: 1,
              },
            }
          : { ok: false, error: { code: 'engine-failed', message: 'The engine stopped.' } },
    };
  }

  it('maps readiness and transcribes takes with the continuity prompt', async () => {
    let setupRequested = false;
    const provider = createSpeechInputProvider(
      fakeSpeech({ state: 'download-required', reason: 'Download a model.' }),
      { onRequestSetup: () => (setupRequested = true) },
    );
    expect(await provider.status()).to.deep.equal({
      state: 'download-required',
      reason: 'Download a model.',
    });
    provider.requestSetup?.();
    expect(setupRequested).to.equal(true);
    const transcript = await provider.transcribe(new ArrayBuffer(44), {
      prompt: 'tail',
      signal: new AbortController().signal,
    });
    expect(transcript.text).to.equal('heard tail');
  });

  it('strips the ellipses Whisper writes for pauses', async () => {
    expect(stripPauseEllipses('Can you talk about the new...')).to.equal(
      'Can you talk about the new',
    );
    expect(stripPauseEllipses('...release of DocBlocks... and all… the cool stuff')).to.equal(
      'release of DocBlocks and all the cool stuff',
    );
    expect(stripPauseEllipses('dictation..., text to speech...?')).to.equal(
      'dictation, text to speech?',
    );
    expect(stripPauseEllipses(' … ')).to.equal('');
    expect(stripPauseEllipses('Version 2.7.4 runs on .NET. Done.')).to.equal(
      'Version 2.7.4 runs on .NET. Done.',
    );
    const provider = createSpeechInputProvider(fakeSpeech({ state: 'ready' }), {
      onRequestSetup: () => undefined,
    });
    const transcript = await provider.transcribe(new ArrayBuffer(44), {
      prompt: 'or... other content...',
      signal: new AbortController().signal,
    });
    expect(transcript.text).to.equal('heard or other content');
  });

  it('drops the captions Whisper writes for room noise and near silence', async () => {
    // Takes captured from a fan-noise session.
    expect(stripNonSpeechCues(' [Music]\n')).to.equal('');
    expect(stripNonSpeechCues('[Music] [Music] [ wind ]')).to.equal('');
    expect(stripNonSpeechCues(' (wind blowing)\n')).to.equal('');
    expect(stripNonSpeechCues('(upbeat music) (fan whirring).')).to.equal('');
    expect(stripNonSpeechCues('♪ ♪')).to.equal('');
    expect(stripNonSpeechCues('[BLANK_AUDIO]')).to.equal('');
    expect(stripNonSpeechCues('Thanks for watching!')).to.equal('');
    expect(stripNonSpeechCues('Thank you so much for watching. [Music]')).to.equal('');
    expect(stripNonSpeechCues('Please subscribe.')).to.equal('');
    // Speech around a caption survives with its word breaks.
    expect(stripNonSpeechCues('[Music] Hello there! How you doing? [Music]')).to.equal(
      'Hello there! How you doing?',
    );
    expect(stripNonSpeechCues('picking up[Music]the\n sound')).to.equal('picking up the sound');
    // Spoken parentheticals, and sign-offs inside real speech, stay.
    expect(stripNonSpeechCues('The plan (and the budget) is ready.')).to.equal(
      'The plan (and the budget) is ready.',
    );
    expect(stripNonSpeechCues('(wind blowing) Hello')).to.equal('(wind blowing) Hello');
    expect(stripNonSpeechCues('Thanks for watching the demo.')).to.equal(
      'Thanks for watching the demo.',
    );
    expect(stripNonSpeechCues('Thank you.')).to.equal('Thank you.');

    const cues: string[] = [];
    const speech = fakeSpeech({ state: 'ready' });
    const provider = createSpeechInputProvider(
      {
        ...speech,
        transcribe: async () => ({
          ok: true,
          value: { text: cues.shift() ?? '', language: 'en', segments: [], durationMs: 1 },
        }),
      },
      { onRequestSetup: () => undefined },
    );
    const take = () =>
      provider.transcribe(new ArrayBuffer(44), { signal: new AbortController().signal });
    cues.push(' [Music]\n', 'Hello [Music], everyone...');
    expect((await take()).text).to.equal('');
    expect((await take()).text).to.equal('Hello, everyone');
  });

  it('passes timed segments through verbatim when timestamps are requested', async () => {
    const provider = createSpeechInputProvider(fakeSpeech({ state: 'ready' }), {
      onRequestSetup: () => undefined,
    });
    const timed = await provider.transcribe(new ArrayBuffer(44), {
      timestamps: true,
      signal: new AbortController().signal,
    });
    expect(timed.segments).to.deep.equal([
      {
        start: 0.5,
        end: 0.9,
        text: 'heard...',
        words: [{ start: 0.5, end: 0.9, text: 'heard...' }],
      },
    ]);
    const plain = await provider.transcribe(new ArrayBuffer(44), {
      signal: new AbortController().signal,
    });
    expect(plain).to.not.have.property('segments');
  });

  it('turns a failed transcription and an aborted take into rejections', async () => {
    const failing = createSpeechInputProvider(fakeSpeech({ state: 'ready' }, false), {
      onRequestSetup: () => undefined,
    });
    let message = '';
    await failing
      .transcribe(new ArrayBuffer(44), { signal: new AbortController().signal })
      .catch((error: Error) => (message = error.message));
    expect(message).to.equal('The engine stopped.');
    const controller = new AbortController();
    controller.abort();
    let name = '';
    await createSpeechInputProvider(fakeSpeech({ state: 'ready' }), {
      onRequestSetup: () => undefined,
    })
      .transcribe(new ArrayBuffer(44), { signal: controller.signal })
      .catch((error: DOMException) => (name = error.name));
    expect(name).to.equal('AbortError');
  });
});

describe('useReadAloud', () => {
  const originalContext = globalThis.AudioContext;
  before(() => {
    (globalThis as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  });
  after(() => {
    (globalThis as { AudioContext: unknown }).AudioContext = originalContext;
  });

  function synthSpeech(requests: SpeechSynthesizeRequest[], fail = false): DocBlocksHostSpeechAPI {
    return {
      status: async () => ({ stt: { state: 'unavailable' }, tts: { state: 'ready' } }),
      onStatus: () => () => undefined,
      catalog: async () => ({ ok: true, value: { models: [], voices: [] } }),
      installModel: () => ({ done: new Promise(() => undefined), cancel: () => undefined }),
      removeModel: async () => ({ ok: true, value: null }),
      getPreferences: async () => ({ sttModel: null, voice: null, speed: 1 }),
      setPreferences: async () => ({ sttModel: null, voice: null, speed: 1 }),
      prepare: async () => ({ ok: true, value: null }),
      synthesize(request, onEvent: (event: SpeechSynthesizeEvent) => void) {
        requests.push(request);
        if (fail) {
          return {
            done: Promise.resolve({
              ok: false as const,
              error: { code: 'model-missing' as const, message: 'Download the voices.' },
            }),
            cancel: () => undefined,
          };
        }
        onEvent({
          kind: 'chunk',
          chunk: { ...second(0, 3), durationSec: 3, textStart: 0, textEnd: request.text.length },
        });
        return {
          done: Promise.resolve({
            ok: true as const,
            value: {
              voice: 'af_heart',
              model: 'kokoro-82m-v1.0',
              sampleRate: 24_000,
              durationSec: 3,
              chunks: 1,
            },
          }),
          cancel: () => undefined,
        };
      },
    };
  }

  it('synthesizes each segment in order and reads them', async () => {
    const requests: SpeechSynthesizeRequest[] = [];
    const hook = await renderHook(() => useReadAloud(synthSpeech(requests)), {});
    try {
      await act(async () =>
        hook.result.current.start('# Title\n\nFirst paragraph.\n\nSecond one.'),
      );
      await advanceTime(50);
      expect(requests.map((r) => r.text)).to.deep.equal([
        'Title.',
        'First paragraph.',
        'Second one.',
      ]);
      expect(hook.result.current.state.phase).to.equal('reading');
      if (hook.result.current.state.phase === 'reading') {
        expect(hook.result.current.state.segments).to.equal(3);
      }
      await act(async () => hook.result.current.stop());
      expect(hook.result.current.state.phase).to.equal('idle');
    } finally {
      // Always release the player, so a failure cannot leave a timer running.
      await act(async () => hook.result.current.stop());
      await hook.unmount();
    }
  });

  const segmentOf = (state: ReadAloudState) => (state.phase === 'reading' ? state.segment : null);

  it('moves to the previous and next segment along the timeline', async () => {
    const requests: SpeechSynthesizeRequest[] = [];
    const hook = await renderHook(() => useReadAloud(synthSpeech(requests)), {});
    const segment = () => segmentOf(hook.result.current.state);
    try {
      await act(async () =>
        hook.result.current.start('# Title\n\nFirst paragraph.\n\nSecond one.'),
      );
      await advanceTime(50);
      expect(segment()).to.equal(0);
      await act(async () => hook.result.current.next());
      expect(segment()).to.equal(1);
      await act(async () => hook.result.current.next());
      expect(segment()).to.equal(2);
      // Next on the last segment stays put.
      await act(async () => hook.result.current.next());
      expect(segment()).to.equal(2);
      await act(async () => hook.result.current.previous());
      expect(segment()).to.equal(1);
      // Well into a segment, previous goes back to its start first.
      FakeAudioContext.latest!.currentTime += 2.5;
      await act(async () => hook.result.current.previous());
      expect(segment()).to.equal(1);
      await act(async () => hook.result.current.previous());
      expect(segment()).to.equal(0);
      // Every skip stayed on the one synthesized timeline.
      expect(requests).to.have.length(3);
    } finally {
      await act(async () => hook.result.current.stop());
      await hook.unmount();
    }
  });

  it('follows the playhead between player events', async () => {
    const hook = await renderHook(() => useReadAloud(synthSpeech([])), {});
    try {
      await act(async () =>
        hook.result.current.start('# Title\n\nFirst paragraph.\n\nSecond one.'),
      );
      await advanceTime(50);
      expect(segmentOf(hook.result.current.state)).to.equal(0);
      // Synthesis is done, so no chunk arrives to report the next segment.
      FakeAudioContext.latest!.currentTime += 3.5;
      await advanceTime(300);
      expect(segmentOf(hook.result.current.state)).to.equal(1);
    } finally {
      await act(async () => hook.result.current.stop());
      await hook.unmount();
    }
  });

  it('synthesizes again from a segment outside the timeline', async () => {
    interface Call {
      readonly text: string;
      cancelled: boolean;
      emit(): void;
      finish(): void;
    }
    const calls: Call[] = [];
    const speech: DocBlocksHostSpeechAPI = {
      ...synthSpeech([]),
      synthesize(request, onEvent) {
        let settle!: (result: SpeechResult<SpeechSynthesisSummary>) => void;
        const done = new Promise<SpeechResult<SpeechSynthesisSummary>>((resolve) => {
          settle = resolve;
        });
        const call: Call = {
          text: request.text,
          cancelled: false,
          emit: () =>
            onEvent({
              kind: 'chunk',
              chunk: {
                ...second(0, 3),
                durationSec: 3,
                textStart: 0,
                textEnd: request.text.length,
              },
            }),
          finish: () =>
            settle({
              ok: true,
              value: {
                voice: 'af_heart',
                model: 'kokoro-82m-v1.0',
                sampleRate: 24_000,
                durationSec: 3,
                chunks: 1,
              },
            }),
        };
        calls.push(call);
        return {
          done,
          cancel: () => {
            call.cancelled = true;
            settle({ ok: false, error: { code: 'cancelled', message: 'Narration stopped.' } });
          },
        };
      },
    };
    const hook = await renderHook(() => useReadAloud(speech), {});
    const segment = () => segmentOf(hook.result.current.state);
    try {
      await act(async () =>
        hook.result.current.start('# Title\n\nFirst paragraph.\n\nSecond one.'),
      );
      await advanceTime(50);
      await act(async () => {
        calls[0]!.emit();
        calls[0]!.finish();
      });
      await advanceTime(10);
      await act(async () => hook.result.current.resume());
      expect(segment()).to.equal(0);

      // The next segment is still being made: wait where it will begin.
      await act(async () => hook.result.current.next());
      expect(hook.result.current.state).to.include({ segment: 1, waiting: true });
      expect(calls).to.have.length(2);

      // Past that, synthesis starts over from the target.
      await act(async () => hook.result.current.next());
      await advanceTime(10);
      expect(calls[1]!.cancelled).to.equal(true);
      expect(calls.map((call) => call.text)).to.deep.equal([
        'Title.',
        'First paragraph.',
        'Second one.',
      ]);
      expect(segment()).to.equal(2);

      await act(async () => {
        calls[2]!.emit();
        calls[2]!.finish();
      });
      await advanceTime(10);
      expect(hook.result.current.state).to.include({ segment: 2, waiting: false });

      // The new timeline starts at segment 2, so going back synthesizes again.
      await act(async () => hook.result.current.previous());
      await advanceTime(10);
      expect(calls.at(-1)!.text).to.equal('First paragraph.');
      expect(segment()).to.equal(1);
    } finally {
      await act(async () => hook.result.current.stop());
      await hook.unmount();
    }
  });

  it('surfaces a synthesis failure', async () => {
    const hook = await renderHook(() => useReadAloud(synthSpeech([], true)), {});
    await act(async () => hook.result.current.start('Hello there.'));
    await advanceTime(50);
    expect(hook.result.current.state).to.deep.equal({
      phase: 'error',
      message: 'Download the voices.',
    });
    await hook.unmount();
  });
});
