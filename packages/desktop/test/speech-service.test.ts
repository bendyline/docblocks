import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  SpeechInstallEvent,
  SpeechSynthesisSummary,
  SpeechSynthesizeEvent,
  SpeechTranscript,
} from '@bendyline/docblocks/host';
import { SpeechModelStore, type SpeechModelEntry } from '../main/speech/speech-models.js';
import { SpeechPreferenceStore } from '../main/speech/speech-preferences.js';
import {
  SpeechService,
  type SttEngine,
  type TtsEngine,
  type TtsSynthesisInput,
} from '../main/speech/speech-service.js';
import { WhisperEngineError } from '../main/speech/whisper-engine.js';

const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const WEIGHTS = new Uint8Array([1, 2, 3, 4]);
const MODEL = new Uint8Array([5, 6, 7]);
const VOICE = new Uint8Array([8, 9]);

const CATALOG: readonly SpeechModelEntry[] = [
  {
    id: 'whisper-base.en',
    kind: 'stt',
    label: 'Base',
    description: 'Recommended.',
    recommended: true,
    license: 'MIT',
    licenseUrl: 'https://example.test/l',
    files: [{ name: 'w.bin', url: 'https://m.test/w.bin', sha256: sha(WEIGHTS), size: 4 }],
  },
  {
    id: 'kokoro-82m-v1.0',
    kind: 'tts',
    label: 'Kokoro',
    description: 'Voices.',
    recommended: true,
    license: 'Apache-2.0',
    licenseUrl: 'https://example.test/l',
    files: [
      {
        name: 'onnx/model_quantized.onnx',
        url: 'https://m.test/m.onnx',
        sha256: sha(MODEL),
        size: 3,
      },
      {
        name: 'voices/af_heart.bin',
        url: 'https://m.test/af_heart.bin',
        sha256: sha(VOICE),
        size: 2,
      },
    ],
  },
];

const fetchImpl = (async (url: string | URL | Request) => {
  const body = {
    'https://m.test/w.bin': WEIGHTS,
    'https://m.test/m.onnx': MODEL,
    'https://m.test/af_heart.bin': VOICE,
  }[String(url)];
  return body ? new Response(body) : new Response('', { status: 404 });
}) as typeof fetch;

class FakeStt implements SttEngine {
  readonly calls: Array<{ model: string; prompt?: string }> = [];
  stopped = 0;
  failWith: unknown = null;
  async prepare(): Promise<void> {}
  async transcribe(
    model: string,
    input: { audio: ArrayBuffer; prompt?: string },
  ): Promise<SpeechTranscript> {
    if (this.failWith) throw this.failWith;
    this.calls.push({ model, ...(input.prompt ? { prompt: input.prompt } : {}) });
    return { text: 'Hello.', language: 'en', segments: [], durationMs: 5 };
  }
  async stop(): Promise<void> {
    this.stopped += 1;
  }
}

class FakeTts implements TtsEngine {
  inputs: TtsSynthesisInput[] = [];
  async prepare(): Promise<void> {}
  async synthesize(
    input: TtsSynthesisInput,
    onEvent: (event: SpeechSynthesizeEvent) => void,
    signal?: AbortSignal,
  ): Promise<SpeechSynthesisSummary> {
    this.inputs.push(input);
    onEvent({
      kind: 'chunk',
      chunk: {
        index: 0,
        pcm: new ArrayBuffer(8),
        sampleRate: 24_000,
        durationSec: 0.1,
        textStart: 0,
        textEnd: input.text.length,
      },
    });
    if (input.text === 'slow') {
      await new Promise((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    return {
      voice: input.voice,
      model: 'kokoro-82m-v1.0',
      sampleRate: 24_000,
      durationSec: 0.1,
      chunks: 1,
    };
  }
  async stop(): Promise<void> {}
}

function collect<T extends { kind: string }>(): {
  events: T[];
  emit: (e: T) => void;
  ended: Promise<T>;
} {
  const events: T[] = [];
  let resolveEnd: (event: T) => void = () => undefined;
  const ended = new Promise<T>((resolve) => {
    resolveEnd = resolve;
  });
  return {
    events,
    ended,
    emit: (event) => {
      events.push(event);
      if (event.kind === 'done' || event.kind === 'error') resolveEnd(event);
    },
  };
}

describe('SpeechService', () => {
  let root: string;
  let stt: FakeStt;
  let tts: FakeTts;
  let service: SpeechService;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'docblocks-speech-service-'));
    stt = new FakeStt();
    tts = new FakeTts();
    service = new SpeechService({
      models: new SpeechModelStore({
        root: path.join(root, 'models'),
        sharedHome: null,
        fetchImpl,
        catalog: CATALOG,
      }),
      preferences: new SpeechPreferenceStore(path.join(root, 'preferences.json')),
      stt,
      tts,
    });
  });
  afterEach(async () => {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  });

  async function install(id: string): Promise<SpeechInstallEvent[]> {
    const sink = collect<SpeechInstallEvent>();
    service.startInstall(`k-${id}`, id, sink.emit);
    await sink.ended;
    return sink.events;
  }

  it('asks for downloads before anything is installed', async () => {
    expect(await service.status()).to.deep.equal({
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
    const result = await service.transcribe({ audio: new ArrayBuffer(44), mimeType: 'audio/wav' });
    expect(result.ok).to.equal(false);
    if (!result.ok) expect(result.error.code).to.equal('model-missing');
  });

  it('asks for an explicit update when installed speech pins change', async () => {
    await install('whisper-base.en');
    await install('kokoro-82m-v1.0');
    for (const entry of CATALOG) {
      const file = path.join(root, 'models', entry.id, 'manifest.json');
      const manifest = JSON.parse(await readFile(file, 'utf8'));
      manifest.files[0].sha256 = 'a'.repeat(64);
      await writeFile(file, JSON.stringify(manifest));
    }
    const status = await service.status();
    expect(status.stt).to.include({
      state: 'download-required',
      reason: 'Update the dictation model in Settings to start dictating.',
    });
    expect(status.tts).to.include({
      state: 'download-required',
      reason: 'Update the narration model in Settings to read documents aloud.',
    });
    expect(stt.calls).to.deep.equal([]);
    expect(tts.inputs).to.deep.equal([]);
  });

  it('installs with progress, publishes status, and then transcribes', async () => {
    const statuses: string[] = [];
    service.onStatus((status) => statuses.push(status.stt.state));
    const events = await install('whisper-base.en');
    expect(events.at(-1)?.kind).to.equal('done');
    expect(events.some((e) => e.kind === 'progress')).to.equal(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(statuses).to.include('ready');
    const result = await service.transcribe({
      audio: new ArrayBuffer(44),
      mimeType: 'audio/wav',
      prompt: 'tail',
    });
    expect(result).to.deep.equal({
      ok: true,
      value: { text: 'Hello.', language: 'en', segments: [], durationMs: 5 },
    });
    expect(stt.calls[0]?.model).to.match(/w\.bin$/);
    expect(stt.calls[0]?.prompt).to.equal('tail');
  });

  it('maps engine failures into the wire vocabulary', async () => {
    await install('whisper-base.en');
    stt.failWith = new WhisperEngineError('engine-unavailable', 'Needs the runtime.', 'exit');
    const result = await service.transcribe({ audio: new ArrayBuffer(44), mimeType: 'audio/wav' });
    expect(result).to.deep.equal({
      ok: false,
      error: { code: 'engine-unavailable', message: 'Needs the runtime.', detail: 'exit' },
    });
  });

  it('reports an unavailable engine and refuses its downloads', async () => {
    const unavailable = new SpeechService({
      models: new SpeechModelStore({
        root: path.join(root, 'm2'),
        sharedHome: null,
        fetchImpl,
        catalog: CATALOG,
      }),
      preferences: new SpeechPreferenceStore(path.join(root, 'p2.json')),
      stt,
      tts: { unavailable: 'Narration needs macOS 14 or later.' },
    });
    expect((await unavailable.status()).tts).to.deep.equal({
      state: 'unavailable',
      reason: 'Narration needs macOS 14 or later.',
    });
    const catalog = await unavailable.catalog();
    expect(catalog.ok && catalog.value.models.map((m) => m.id)).to.deep.equal(['whisper-base.en']);
    expect(catalog.ok && catalog.value.voices).to.deep.equal([]);
    const sink = collect<SpeechInstallEvent>();
    unavailable.startInstall('k', 'kokoro-82m-v1.0', sink.emit);
    const ended = await sink.ended;
    expect(ended.kind === 'error' && ended.error.code).to.equal('engine-unavailable');
  });

  it('reports a denied microphone as a permission problem', async () => {
    const denied = new SpeechService({
      models: new SpeechModelStore({
        root: path.join(root, 'm3'),
        sharedHome: null,
        catalog: CATALOG,
      }),
      preferences: new SpeechPreferenceStore(path.join(root, 'p3.json')),
      stt,
      tts,
      microphoneAccess: () => 'denied',
    });
    expect((await denied.status()).stt.state).to.equal('permission-required');
  });

  it('validates preferences and restarts dictation when the model changes', async () => {
    let failed = false;
    await service.setPreferences({ voice: 'nobody' }).catch(() => {
      failed = true;
    });
    expect(failed).to.equal(true);
    await service.setPreferences({ sttModel: 'whisper-base.en' });
    expect(stt.stopped).to.equal(1);
    expect((await service.getPreferences()).sttModel).to.equal('whisper-base.en');
  });

  it('synthesizes with the preferred voice and speed', async () => {
    await install('kokoro-82m-v1.0');
    await service.setPreferences({ speed: 1.5 });
    const sink = collect<SpeechSynthesizeEvent>();
    service.startSynthesis('s1', { text: 'Read this.' }, sink.emit);
    const ended = await sink.ended;
    expect(ended.kind).to.equal('done');
    expect(sink.events[0]?.kind).to.equal('chunk');
    expect(tts.inputs[0]).to.include({ voice: 'af_heart', speed: 1.5, text: 'Read this.' });
    expect(tts.inputs[0]?.voiceFile).to.match(/af_heart\.bin$/);
  });

  it('reports a cancelled synthesis as cancelled', async () => {
    await install('kokoro-82m-v1.0');
    const sink = collect<SpeechSynthesizeEvent>();
    service.startSynthesis('s2', { text: 'slow' }, sink.emit);
    await new Promise((resolve) => setTimeout(resolve, 20));
    service.cancelSynthesis('s2');
    const ended = await sink.ended;
    expect(ended.kind === 'error' && ended.error.code).to.equal('cancelled');
  });

  it('refuses an unknown voice', async () => {
    await install('kokoro-82m-v1.0');
    const sink = collect<SpeechSynthesizeEvent>();
    service.startSynthesis('s3', { text: 'Hi', voice: 'bm_lewis' }, sink.emit);
    const ended = await sink.ended;
    expect(ended.kind === 'error' && ended.error.code).to.equal('invalid-request');
  });

  it('removes a model after stopping its engine', async () => {
    await install('whisper-base.en');
    expect(await service.removeModel('whisper-base.en')).to.deep.equal({ ok: true, value: null });
    expect(stt.stopped).to.equal(1);
    expect((await service.status()).stt.state).to.equal('download-required');
  });
});
