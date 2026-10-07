import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  KOKORO_VOICES,
  KOKORO_VOICE_BYTES,
  SPEECH_MODEL_CATALOG,
  SpeechModelStore,
  downloadBytes,
  type SpeechModelEntry,
} from '../main/speech/speech-models.js';

function bytes(seed: number, length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * seed) % 256);
}

const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

const WEIGHTS = bytes(7, 2048);
const MODEL = bytes(3, 1024);
const VOICE = bytes(5, 256);

const CATALOG: readonly SpeechModelEntry[] = [
  {
    id: 'stt-test',
    kind: 'stt',
    label: 'STT test',
    description: 'One weights file.',
    recommended: true,
    license: 'MIT',
    licenseUrl: 'https://example.test/license',
    files: [
      {
        name: 'weights.bin',
        url: 'https://m.test/weights.bin',
        sha256: sha(WEIGHTS),
        size: WEIGHTS.length,
      },
    ],
    sharedPath: ['.gezel', 'engines', 'whisper-cpp', 'models', 'stt-test', 'weights.bin'],
  },
  {
    id: 'tts-test',
    kind: 'tts',
    label: 'TTS test',
    description: 'A model plus a nested voice.',
    recommended: true,
    license: 'Apache-2.0',
    licenseUrl: 'https://example.test/license',
    files: [
      {
        name: 'onnx/model.onnx',
        url: 'https://m.test/model.onnx',
        sha256: sha(MODEL),
        size: MODEL.length,
      },
      { name: 'voices/a.bin', url: 'https://m.test/a.bin', sha256: sha(VOICE), size: VOICE.length },
    ],
  },
];

function fetchFor(files: Record<string, Uint8Array>): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    const key = String(url);
    urls.push(key);
    const body = files[key];
    return body ? new Response(body, { status: 200 }) : new Response('missing', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

describe('SpeechModelStore', () => {
  let root: string;
  let home: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'docblocks-speech-models-'));
    home = path.join(root, 'home');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const store = (fetchImpl?: typeof fetch, sharedHome: string | null = null) =>
    new SpeechModelStore({
      root: path.join(root, 'models'),
      sharedHome,
      catalog: CATALOG,
      ...(fetchImpl ? { fetchImpl } : {}),
    });

  it('lists every model as not installed initially', async () => {
    const models = await store().list();
    expect(models.map((m) => [m.id, m.installed, m.source])).to.deep.equal([
      ['stt-test', false, null],
      ['tts-test', false, null],
    ]);
    expect(models[1]?.downloadBytes).to.equal(MODEL.length + VOICE.length);
  });

  it('installs nested files with aggregate progress, then locates them', async () => {
    const { fetchImpl } = fetchFor({
      'https://m.test/model.onnx': MODEL,
      'https://m.test/a.bin': VOICE,
    });
    const models = store(fetchImpl);
    const progress: Array<[number, number]> = [];
    await models.install('tts-test', { onProgress: (r, t) => progress.push([r, t]) });
    expect(progress.at(-1)).to.deep.equal([
      MODEL.length + VOICE.length,
      MODEL.length + VOICE.length,
    ]);
    const located = await models.locate('tts-test');
    expect(located?.source).to.equal('app');
    expect(new Uint8Array(await readFile(located!.files['voices/a.bin']!))).to.deep.equal(VOICE);
    expect((await models.list())[1]).to.include({ installed: true, source: 'app' });
  });

  it('shares one download between concurrent installs of a model', async () => {
    const fake = fetchFor({ 'https://m.test/weights.bin': WEIGHTS });
    const models = store(fake.fetchImpl);
    await Promise.all([models.install('stt-test'), models.install('stt-test')]);
    expect(fake.urls).to.deep.equal(['https://m.test/weights.bin']);
  });

  it('does not count a model as installed until its manifest exists', async () => {
    const models = store(fetchFor({ 'https://m.test/model.onnx': MODEL }).fetchImpl);
    let failed = false;
    await models.install('tts-test').catch(() => {
      failed = true;
    });
    expect(failed).to.equal(true);
    expect(await models.locate('tts-test')).to.equal(null);
    // The first file is kept, so a retry only fetches what is missing.
    const retry = fetchFor({ 'https://m.test/model.onnx': MODEL, 'https://m.test/a.bin': VOICE });
    await store(retry.fetchImpl).install('tts-test');
    expect(retry.urls).to.deep.equal(['https://m.test/a.bin']);
  });

  it('treats a manifest whose pins or sizes disagree as not installed', async () => {
    const models = store(fetchFor({ 'https://m.test/weights.bin': WEIGHTS }).fetchImpl);
    await models.install('stt-test');
    await writeFile(path.join(root, 'models', 'stt-test', 'weights.bin'), WEIGHTS.subarray(1));
    expect(await models.locate('stt-test')).to.equal(null);
  });

  it('uses a verified shared copy read-only and never deletes it', async () => {
    const shared = path.join(
      home,
      '.gezel',
      'engines',
      'whisper-cpp',
      'models',
      'stt-test',
      'weights.bin',
    );
    await mkdir(path.dirname(shared), { recursive: true });
    await writeFile(shared, WEIGHTS);
    const models = store(undefined, home);
    expect((await models.list())[0]).to.include({ installed: true, source: 'shared' });
    expect((await models.locate('stt-test'))?.files['weights.bin']).to.equal(shared);
    await models.remove('stt-test');
    expect((await stat(shared)).size).to.equal(WEIGHTS.length);
  });

  it('rejects a shared copy whose hash does not match', async () => {
    const shared = path.join(
      home,
      '.gezel',
      'engines',
      'whisper-cpp',
      'models',
      'stt-test',
      'weights.bin',
    );
    await mkdir(path.dirname(shared), { recursive: true });
    await writeFile(shared, bytes(9, WEIGHTS.length));
    expect(await store(undefined, home).locate('stt-test')).to.equal(null);
    // Without a shared home (the MAS sandbox), it is never consulted.
    await writeFile(shared, WEIGHTS);
    expect(await store(undefined, null).locate('stt-test')).to.equal(null);
  });

  it('removes only this app’s copy', async () => {
    const models = store(fetchFor({ 'https://m.test/weights.bin': WEIGHTS }).fetchImpl);
    await models.install('stt-test');
    await models.remove('stt-test');
    expect(await models.locate('stt-test')).to.equal(null);
  });
});

describe('the pinned speech catalog', () => {
  it('pins every file to an exact commit, size and SHA-256', () => {
    for (const entry of SPEECH_MODEL_CATALOG) {
      for (const file of entry.files) {
        expect(file.url, file.name).to.match(
          /^https:\/\/huggingface\.co\/.+\/resolve\/[0-9a-f]{40}\//,
        );
        expect(file.sha256, file.name).to.match(/^[0-9a-f]{64}$/);
        expect(file.size, file.name).to.be.greaterThan(0);
      }
    }
  });

  it('matches Gezel’s Whisper pins and ships every curated Kokoro voice', () => {
    const base = SPEECH_MODEL_CATALOG.find((entry) => entry.id === 'whisper-base.en');
    expect(base?.files[0]?.sha256).to.equal(
      'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002',
    );
    expect(base?.recommended).to.equal(true);
    const kokoro = SPEECH_MODEL_CATALOG.find((entry) => entry.kind === 'tts');
    expect(kokoro?.files.filter((f) => f.name.startsWith('voices/'))).to.have.length(
      KOKORO_VOICES.length,
    );
    expect(
      kokoro?.files.every((f) => !f.name.startsWith('voices/') || f.size === KOKORO_VOICE_BYTES),
    ).to.equal(true);
    expect(downloadBytes(kokoro!)).to.equal(92_361_116 + KOKORO_VOICES.length * KOKORO_VOICE_BYTES);
  });
});
