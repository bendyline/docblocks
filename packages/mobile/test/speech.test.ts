import assert from 'node:assert/strict';
import { createMobileSpeech, type GezelOfflineSpeechPlugin } from '@bendyline/gezel-capacitor';
import type { SpeechPreferences, SpeechSynthesizeEvent } from '@bendyline/docblocks/host';
import { createMobileSpeechHost } from '../src/speech/host';

const LEXICON = 'good ɡ ˈ ʊ d\nhello h ə l ˈ O\nmorning m ˈ ɔ ɹ n ɪ ŋ\nworld w ˈ ɜ ɹ l d\n';
const KOKORO_FILES = [
  'onnx/model_quantized.onnx',
  ...[
    'af_heart',
    'af_bella',
    'af_nicole',
    'am_adam',
    'am_michael',
    'bf_emma',
    'bm_george',
    'bm_lewis',
  ].map((voice) => `voices/${voice}.bin`),
];

function wav(samples: number): ArrayBuffer {
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const text = (at: number, value: string) => {
    for (let i = 0; i < 4; i++) bytes[at + i] = value.charCodeAt(i);
  };
  text(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples * 2, true);
  return bytes.buffer;
}

const rejection = (message: string, code: string) => Object.assign(new Error(message), { code });

function fixture({
  available = true,
  installed = [] as { id: string; files: string[] }[],
  preferences = null as unknown,
} = {}) {
  const calls: string[] = [];
  const listeners: ((event: { id: string; receivedBytes: number; totalBytes: number }) => void)[] =
    [];
  let saved: SpeechPreferences | undefined;
  const plugin: GezelOfflineSpeechPlugin = {
    status: async () => ({ available, models: installed }),
    install: async ({ id }) => {
      calls.push(`install:${id}`);
      for (const listener of listeners) listener({ id, receivedBytes: 50, totalBytes: 0 });
      return { id };
    },
    cancelInstall: async () => void calls.push('cancelInstall'),
    remove: async ({ id }) => void calls.push(`remove:${id}`),
    transcribe: async ({ model, file, words }) => {
      calls.push(`transcribe:${model}:${file}:${words === true}`);
      return {
        language: 'en',
        durationMs: 3,
        segments: [
          {
            start: 0,
            end: 1,
            text: ' Good morning.',
            tokens: [
              { start: 0, end: 0.4, text: ' Good' },
              { start: 0.4, end: 1, text: ' morning.' },
            ],
          },
        ],
      };
    },
    synthesize: async ({ tokens, voices }) => {
      calls.push(`synthesize:${voices}`);
      const pcm = Buffer.alloc(tokens.length * 600 * 2).toString('base64');
      return { pcm, sampleRate: 24_000, durations: tokens.map(() => 1), durationMs: 1 };
    },
    cancel: async () => void calls.push('cancel'),
    release: async () => undefined,
    addListener: async (_event, listener) => {
      listeners.push(listener);
      return { remove: async () => void listeners.splice(listeners.indexOf(listener), 1) };
    },
  };
  const host = createMobileSpeechHost({
    load: async () =>
      createMobileSpeech({ plugin, lexicon: async () => LEXICON, downloadRetryDelaysMs: [1, 1] }),
    readPreferences: () => preferences,
    writePreferences: (value) => {
      saved = value;
    },
  });
  return { host, speech: host.speech, plugin, calls, saved: () => saved };
}

describe('mobile speech host', () => {
  it('asks for downloads before anything is installed', async () => {
    const { speech } = fixture();
    assert.deepEqual(await speech.status(), {
      stt: {
        state: 'download-required',
        reason: 'Download a dictation model to start dictating.',
        model: 'whisper-base.en',
      },
      tts: {
        state: 'download-required',
        reason: 'Download the narration voices to read documents aloud.',
        model: 'kokoro-82m-v1.0',
      },
    });
  });

  it('reports a build without the engine as unavailable', async () => {
    const { speech } = fixture({ available: false });
    const status = await speech.status();
    assert.equal(status.stt.state, 'unavailable');
    assert.equal(status.tts.state, 'unavailable');
    assert.equal((await speech.prepare('stt')).ok, false);
  });

  it('serves the preferred installed dictation model, then the recommended one', async () => {
    const installed = [
      { id: 'whisper-tiny.en', files: ['ggml-tiny.en.bin'] },
      { id: 'whisper-base.en', files: ['ggml-base.en.bin'] },
      { id: 'kokoro-82m-v1.0', files: KOKORO_FILES },
    ];
    assert.deepEqual((await fixture({ installed }).speech.status()).stt, {
      state: 'ready',
      model: 'whisper-base.en',
    });
    const preferred = fixture({
      installed,
      preferences: { sttModel: 'whisper-tiny.en', voice: null, speed: 1 },
    });
    assert.deepEqual((await preferred.speech.status()).stt, {
      state: 'ready',
      model: 'whisper-tiny.en',
    });
    assert.deepEqual((await preferred.speech.status()).tts, {
      state: 'ready',
      model: 'kokoro-82m-v1.0',
    });
  });

  it('lists the phone catalog with install state and every voice', async () => {
    const { speech } = fixture({
      installed: [{ id: 'whisper-tiny.en', files: ['ggml-tiny.en.bin'] }],
    });
    const catalog = await speech.catalog();
    assert.ok(catalog.ok);
    assert.deepEqual(
      catalog.value.models.map((model) => [model.id, model.installed, model.source]),
      [
        ['whisper-tiny.en', true, 'app'],
        ['whisper-base.en', false, null],
        ['kokoro-82m-v1.0', false, null],
      ],
    );
    assert.equal(catalog.value.voices.length, 8);
    assert.ok(catalog.value.voices.every((voice) => voice.modelId === 'kokoro-82m-v1.0'));
  });

  it('downloads with progress and refreshes status listeners', async () => {
    const { speech, calls } = fixture();
    const statuses: string[] = [];
    speech.onStatus((status) => statuses.push(status.stt.state));
    const progress: number[] = [];
    const result = await speech.installModel('whisper-tiny.en', (event) =>
      progress.push(event.receivedBytes),
    ).done;
    assert.ok(result.ok);
    assert.equal(result.value.installed, true);
    assert.deepEqual(calls, ['install:whisper-tiny.en']);
    assert.deepEqual(progress, [50]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(statuses.length, 1);
  });

  it('explains download failures in plain words and keeps the native text as detail', async () => {
    const { speech, plugin } = fixture();
    plugin.install = async () => {
      throw rejection('unexpected end of stream', 'interrupted');
    };
    const interrupted = await speech.installModel('whisper-tiny.en').done;
    assert.deepEqual(interrupted, {
      ok: false,
      error: {
        code: 'model-download-failed',
        message:
          'The download was interrupted. Check your connection, then choose Download to continue where it stopped.',
        detail: 'unexpected end of stream',
      },
    });
    plugin.install = async () => {
      throw rejection('Download paused when the app left the foreground', 'paused');
    };
    const paused = await speech.installModel('whisper-tiny.en').done;
    assert.equal(!paused.ok && paused.error.code, 'cancelled');
    assert.match(!paused.ok ? paused.error.message : '', /continue where it stopped/);
  });

  it('dictates with the chosen model and adds word times only when asked', async () => {
    const installed = [{ id: 'whisper-base.en', files: ['ggml-base.en.bin'] }];
    const { speech, calls } = fixture({ installed });
    const plain = await speech.transcribe!({ audio: wav(160), mimeType: 'audio/wav' });
    assert.deepEqual(plain, {
      ok: true,
      value: {
        text: 'Good morning.',
        language: 'en',
        segments: [{ start: 0, end: 1, text: 'Good morning.' }],
        durationMs: 3,
      },
    });
    const timed = await speech.transcribe!({
      audio: wav(160),
      mimeType: 'audio/wav',
      timestamps: true,
    });
    assert.ok(timed.ok);
    assert.deepEqual(timed.value.segments[0]?.words, [
      { start: 0, end: 0.4, text: 'Good' },
      { start: 0.4, end: 1, text: 'morning.' },
    ]);
    assert.deepEqual(calls, [
      'transcribe:whisper-base.en:ggml-base.en.bin:false',
      'transcribe:whisper-base.en:ggml-base.en.bin:true',
    ]);
  });

  it('refuses to dictate before a model is installed', async () => {
    const result = await fixture().speech.transcribe!({ audio: wav(16), mimeType: 'audio/wav' });
    assert.equal(!result.ok && result.error.code, 'model-missing');
  });

  it('narrates chunk by chunk in the preferred voice with word times', async () => {
    const { speech, calls } = fixture({
      installed: [{ id: 'kokoro-82m-v1.0', files: KOKORO_FILES }],
      preferences: { sttModel: null, voice: 'bm_george', speed: 1.2 },
    });
    const events: SpeechSynthesizeEvent[] = [];
    const result = await speech.synthesize!({ text: 'Hello world. Good morning.' }, (event) =>
      events.push(event),
    ).done;
    assert.ok(result.ok);
    assert.equal(result.value.voice, 'bm_george');
    const chunks = events.flatMap((event) => (event.kind === 'chunk' ? [event.chunk] : []));
    assert.deepEqual(
      chunks.map((chunk) => [chunk.textStart, chunk.textEnd, chunk.wordTimings?.length]),
      [
        [0, 12, 2],
        [13, 26, 2],
      ],
    );
    assert.ok(
      chunks.every((chunk) => chunk.pcm instanceof ArrayBuffer && chunk.pcm.byteLength > 0),
    );
    assert.equal(events.at(-1)?.kind, 'done');
    assert.deepEqual(calls, ['synthesize:voices/bm_george.bin', 'synthesize:voices/bm_george.bin']);
  });

  it('stops narration natively when cancelled', async () => {
    const { speech, plugin, calls } = fixture({
      installed: [{ id: 'kokoro-82m-v1.0', files: KOKORO_FILES }],
    });
    let cancel = () => {};
    plugin.synthesize = async () => {
      cancel();
      throw rejection('Speech stopped', 'cancelled');
    };
    const handle = speech.synthesize!({ text: 'Hello world.' }, () => {});
    cancel = handle.cancel;
    const result = await handle.done;
    assert.equal(!result.ok && result.error.code, 'cancelled');
    assert.ok(calls.includes('cancel'));
  });

  it('validates and persists preferences', async () => {
    const { speech, saved } = fixture();
    await assert.rejects(speech.setPreferences({ speed: 9 }), TypeError);
    assert.deepEqual(await speech.setPreferences({ voice: 'af_bella' }), {
      sttModel: null,
      voice: 'af_bella',
      speed: 1,
    });
    assert.equal(saved()?.voice, 'af_bella');
  });
});
