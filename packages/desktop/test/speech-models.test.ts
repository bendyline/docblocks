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

  const updatedModel = bytes(11, MODEL.length);
  const updatedCatalog = CATALOG.map((entry) => ({
    ...entry,
    files: entry.files.map((file) =>
      file.name === 'onnx/model.onnx' ? { ...file, sha256: sha(updatedModel) } : file,
    ),
  }));

  const updatedStore = (fetchImpl: typeof fetch) =>
    new SpeechModelStore({
      root: path.join(root, 'models'),
      sharedHome: null,
      catalog: updatedCatalog,
      fetchImpl,
    });

  async function installPreviousRevision() {
    await store(
      fetchFor({
        'https://m.test/model.onnx': MODEL,
        'https://m.test/a.bin': VOICE,
      }).fetchImpl,
    ).install('tts-test');
  }

  it('offers an explicit update after a pin change and reuses unchanged voices', async () => {
    await installPreviousRevision();
    const fake = fetchFor({ 'https://m.test/model.onnx': updatedModel });
    const models = updatedStore(fake.fetchImpl);
    expect((await models.list())[1]).to.include({
      installed: false,
      source: null,
      updateRequired: true,
    });
    expect(await models.locate('tts-test')).to.equal(null);
    expect(fake.urls).to.deep.equal([]);
    await models.install('tts-test');
    expect(fake.urls).to.deep.equal(['https://m.test/model.onnx']);
    expect((await models.list())[1]).to.include({ installed: true, source: 'app' });
    expect((await models.list())[1]?.updateRequired).not.to.equal(true);
    const located = await models.locate('tts-test');
    expect(new Uint8Array(await readFile(located!.files['onnx/model.onnx']!))).to.deep.equal(
      updatedModel,
    );
    expect(new Uint8Array(await readFile(located!.files['voices/a.bin']!))).to.deep.equal(VOICE);
  });

  it('preserves the previous manifest and file when update verification fails, then retries', async () => {
    await installPreviousRevision();
    const manifestPath = path.join(root, 'models', 'tts-test', 'manifest.json');
    const previous = await readFile(manifestPath, 'utf8');
    const failed = updatedStore(fetchFor({ 'https://m.test/model.onnx': MODEL }).fetchImpl);
    await failed.install('tts-test').then(
      () => {
        throw new Error('Unverified update was accepted');
      },
      (error: unknown) => expect(error).to.have.property('failure', 'checksum'),
    );
    expect(await readFile(manifestPath, 'utf8')).to.equal(previous);
    expect(
      new Uint8Array(await readFile(path.join(root, 'models', 'tts-test', 'onnx/model.onnx'))),
    ).to.deep.equal(MODEL);
    expect(await failed.locate('tts-test')).to.equal(null);
    expect((await failed.list())[1]?.updateRequired).to.equal(true);
    const retry = fetchFor({ 'https://m.test/model.onnx': updatedModel });
    await updatedStore(retry.fetchImpl).install('tts-test');
    expect(retry.urls).to.deep.equal(['https://m.test/model.onnx']);
  });

  it('does not publish an update cancelled after its last file, and retries without downloads', async () => {
    await installPreviousRevision();
    const manifestPath = path.join(root, 'models', 'tts-test', 'manifest.json');
    const previous = await readFile(manifestPath, 'utf8');
    const models = updatedStore(fetchFor({ 'https://m.test/model.onnx': updatedModel }).fetchImpl);
    const controller = new AbortController();
    await models
      .install('tts-test', {
        signal: controller.signal,
        onProgress: (received, total) => {
          if (received === total) controller.abort();
        },
      })
      .then(
        () => {
          throw new Error('Cancelled update was published');
        },
        (error: unknown) => expect(error).to.have.property('failure', 'aborted'),
      );
    expect(await readFile(manifestPath, 'utf8')).to.equal(previous);
    expect(await models.locate('tts-test')).to.equal(null);
    const retry = fetchFor({});
    await updatedStore(retry.fetchImpl).install('tts-test');
    expect(retry.urls).to.deep.equal([]);
    expect((await models.list())[1]?.installed).to.equal(true);
  });

  it('treats malformed manifests as unavailable without throwing or inventing an update', async () => {
    await installPreviousRevision();
    const manifestPath = path.join(root, 'models', 'tts-test', 'manifest.json');
    const previous = JSON.parse(await readFile(manifestPath, 'utf8'));
    const models = store();
    for (const invalid of [
      null,
      [],
      { ...previous, files: {} },
      { ...previous, files: [null] },
      {
        ...previous,
        files: [previous.files[0], previous.files[0]],
      },
    ]) {
      await writeFile(manifestPath, JSON.stringify(invalid));
      expect(await models.locate('tts-test')).to.equal(null);
      expect((await models.list())[1]?.updateRequired).not.to.equal(true);
    }
  });

  it('acquires its own reference to a verified shared copy and never deletes the original', async () => {
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
    const owned = (await models.locate('stt-test'))!.files['weights.bin']!;
    expect((await stat(owned)).ino).to.equal((await stat(shared)).ino);
    await models.remove('stt-test');
    expect((await stat(shared)).size).to.equal(WEIGHTS.length);
  });

  it('reuses complete multi-file models in both directions and keeps the other installation usable', async () => {
    const fetcher = fetchFor({ 'https://m.test/model.onnx': MODEL, 'https://m.test/a.bin': VOICE });
    const cache = path.join(root, 'gezel-home', 'engines', 'speech-assets');
    const first = new SpeechModelStore({
      root: path.join(root, 'first'),
      sharedHome: null,
      assets: { root: cache },
      catalog: CATALOG,
      fetchImpl: fetcher.fetchImpl,
    });
    const second = new SpeechModelStore({
      root: path.join(root, 'second'),
      sharedHome: null,
      assets: { root: cache },
      catalog: CATALOG,
      fetchImpl: fetcher.fetchImpl,
    });
    await first.install('tts-test');
    expect((await second.list())[1]).to.include({ installed: true, source: 'shared' });
    const b = await second.locate('tts-test');
    const a = await first.locate('tts-test');
    expect(fetcher.urls).to.have.length(2);
    expect((await stat(a!.files['onnx/model.onnx']!)).ino).to.equal(
      (await stat(b!.files['onnx/model.onnx']!)).ino,
    );
    await first.remove('tts-test');
    expect(await second.locate('tts-test')).not.to.equal(null);
    await first.install('tts-test');
    expect(fetcher.urls).to.have.length(2);
    await second.remove('tts-test');
    expect(await first.locate('tts-test')).not.to.equal(null);
    await first.remove('tts-test');
    expect((await second.list())[1].installed).to.equal(false);
  });

  it('cancels a shared-cache waiter without cancelling the other app’s download', async () => {
    let start: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    let release: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = (async () => {
      start();
      await waiting;
      return new Response(WEIGHTS);
    }) as typeof fetch;
    const assets = { root: path.join(root, 'shared-cache') };
    const first = new SpeechModelStore({
      root: path.join(root, 'first'),
      sharedHome: null,
      assets,
      catalog: CATALOG,
      fetchImpl,
    });
    const second = new SpeechModelStore({
      root: path.join(root, 'second'),
      sharedHome: null,
      assets,
      catalog: CATALOG,
      fetchImpl,
    });
    const download = first.install('stt-test');
    await started;
    const controller = new AbortController();
    const cancelled = second
      .install('stt-test', { signal: controller.signal })
      .catch((error) => error);
    controller.abort();
    expect(await cancelled).to.have.property('failure', 'aborted');
    release();
    await download;
    expect(await first.locate('stt-test')).not.to.equal(null);
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
    expect(downloadBytes(kokoro!)).to.equal(92_361_055 + KOKORO_VOICES.length * KOKORO_VOICE_BYTES);
  });
});
