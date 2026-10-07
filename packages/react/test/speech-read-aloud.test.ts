import { expect } from 'chai';
import type {
  DocBlocksHostSpeechAPI,
  SpeechReadiness,
  SpeechSynthesizeEvent,
  SpeechSynthesizeRequest,
} from '@bendyline/docblocks/host';
import {
  AutoPlayGate,
  ProgressivePlayer,
  type PlayerAudioContext,
  type ProgressivePlayerSnapshot,
} from '../src/Speech/progressive-player.js';
import { createSpeechInputProvider } from '../src/Speech/speech-input-provider.js';
import { useReadAloud } from '../src/Speech/useReadAloud.js';
import { act, advanceTime, renderHook } from './helpers/renderHook.js';

/** Just enough AudioContext for the player: buffers have a duration, time is settable. */
class FakeAudioContext {
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

describe('AutoPlayGate', () => {
  const snapshot = (bufferedDuration: number, currentTime = 0): ProgressivePlayerSnapshot => ({
    bufferedDuration,
    currentTime,
    isPlaying: false,
    waitingForAudio: false,
    complete: false,
    currentChunk: 0,
  });

  it('needs four seconds ahead and faster-than-realtime generation', () => {
    const gate = new AutoPlayGate();
    expect(gate.ready(snapshot(2), { completedCharacters: 10, totalCharacters: 1000 }, 0)).to.equal(
      false,
    );
    // 2 s → 6 s of audio in 2 s of wall time: 2× realtime.
    expect(
      gate.ready(snapshot(6), { completedCharacters: 40, totalCharacters: 1000 }, 2000),
    ).to.equal(true);
  });

  it('waits when generation is slower than playback and much remains', () => {
    const gate = new AutoPlayGate();
    gate.ready(snapshot(1), { completedCharacters: 10, totalCharacters: 10_000 }, 0);
    expect(
      gate.ready(snapshot(5), { completedCharacters: 20, totalCharacters: 10_000 }, 10_000),
    ).to.equal(false);
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
                segments: [],
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
