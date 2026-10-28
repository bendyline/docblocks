import { expect } from 'chai';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  AiImageAccess,
  AiImageEvent,
  AiImageInstallEvent,
  AiImagePreferences,
  AiStatus,
} from '@bendyline/docblocks/host';
import {
  AiImageService,
  type ProviderEnsureEvent,
  type ProviderImageModel,
  type ProviderImageProgress,
  type ProviderImages,
} from '../main/ai/ai-image-service.js';
import { imageGraphicsDriverBlock } from '../main/ai/graphics-driver.js';
import { DEFAULT_IMAGE_PREFERENCES, ImagePreferenceStore } from '../main/ai/image-preferences.js';

const READY: AiStatus = {
  kind: 'ready',
  provider: { name: 'Gezel', version: '1.0.0', mode: 'hosted' },
  model: null,
  activeRequests: 0,
};

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 4, 0, 0, 0, 4,
  0,
]);

const FLUX: ProviderImageModel = {
  id: 'sd-cpp:flux-2-klein-4b-q4',
  name: 'FLUX.2 Klein 4B (Q4)',
  description: 'A fast model.',
  availability: 'download-required',
  download_bytes: 5_207_178_964,
  license: 'Apache 2.0',
  commercial_use: true,
  renders_text: true,
  prompt_style: 'sentences',
  hardware_tier: 'high',
  min_ram_gb: 16,
  fit: { verdict: 'fits', reason: '' },
};

class MemoryPreferences {
  value: AiImagePreferences = DEFAULT_IMAGE_PREFERENCES;
  async get() {
    return this.value;
  }
  async set(patch: Partial<AiImagePreferences>) {
    this.value = { ...this.value, ...patch };
    return this.value;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sdkError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

/** A scripted provider image surface. */
class FakeImages implements ProviderImages {
  accessValue: 'granted' | 'needs-approval' | 'no-engine' | 'unsupported' = 'granted';
  installed = new Set<string>();
  lastGenerate: { input: Record<string, unknown>; signal: AbortSignal } | null = null;
  render = deferred<void>();
  progress: ProviderImageProgress[] = [];
  generateError: Error | null = null;
  approval: ((code: (value: string) => void) => Promise<void>) | null = null;
  ensureEventsScript: ProviderEnsureEvent[] = [];
  cancelled: string[] = [];
  removed: string[] = [];

  async access() {
    return this.accessValue;
  }
  async requestAccess(onVerificationCode: (code: string) => void) {
    if (this.approval) await this.approval(onVerificationCode);
    this.accessValue = 'granted';
  }
  async models() {
    return [
      {
        ...FLUX,
        availability: this.installed.has(FLUX.id) ? ('available' as const) : FLUX.availability,
      },
    ];
  }
  async ensure(id: string) {
    return this.installed.has(id)
      ? { status: 'ready' as const }
      : { status: 'downloading' as const, jobId: 'flux-job' };
  }
  async *ensureEvents(_jobId: string, signal: AbortSignal): AsyncIterable<ProviderEnsureEvent> {
    for (const event of this.ensureEventsScript) {
      if (signal.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (event.type === 'done') this.installed.add(FLUX.id);
      yield event;
    }
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
  }
  async cancelEnsure(jobId: string) {
    this.cancelled.push(jobId);
  }
  async remove(id: string) {
    this.removed.push(id);
  }
  async generate(
    input: Record<string, unknown> & { prompt: string },
    options: { signal: AbortSignal; onProgress(progress: ProviderImageProgress): void },
  ) {
    this.lastGenerate = { input, signal: options.signal };
    for (const progress of this.progress) options.onProgress(progress);
    if (this.generateError) throw this.generateError;
    await Promise.race([
      this.render.promise,
      new Promise<void>((_resolve, reject) =>
        options.signal.addEventListener('abort', () => reject(sdkError('cancelled'))),
      ),
    ]);
    return {
      png: PNG,
      width: 1024,
      height: 768,
      seed: 7,
      model: 'sd-cpp:flux-2-klein-4b-q4',
      durationMs: 12_100.4,
    };
  }
}

function setup(options: { status?: AiStatus; images?: FakeImages | null } = {}) {
  let status = options.status ?? READY;
  let images: FakeImages | null = options.images === undefined ? new FakeImages() : options.images;
  const statusListeners = new Set<(status: AiStatus) => void>();
  const preferences = new MemoryPreferences();
  let blocked: Extract<AiImageAccess, { kind: 'unavailable' }> | null = null;
  const service = new AiImageService({
    images: () => (status.kind === 'ready' ? images : null),
    status: async () => status,
    onStatus: (listener) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    preferences,
    blocked: () => blocked,
  });
  return {
    service,
    preferences,
    get images() {
      return images;
    },
    setStatus(next: AiStatus, nextImages: FakeImages | null = images) {
      status = next;
      images = nextImages;
      for (const listener of statusListeners) listener(next);
    },
    block(value: typeof blocked) {
      blocked = value;
    },
  };
}

function collect<T extends { kind: string }>() {
  const events: T[] = [];
  const ended = deferred<T>();
  return {
    events,
    ended: ended.promise,
    emit: (event: T) => {
      events.push(event);
      if (event.kind !== 'progress') ended.resolve(event);
    },
  };
}

describe('AiImageService', () => {
  it('reports access from the connection, the provider and the graphics driver', async () => {
    const off = setup({ status: { kind: 'unavailable', reason: 'opt-out' } });
    expect((await off.service.access()).kind).to.equal('unavailable');

    const outdated = setup({ images: null });
    expect(await outdated.service.access()).to.deep.equal({ kind: 'provider-outdated' });

    const fixture = setup();
    expect(await fixture.service.access()).to.deep.equal({ kind: 'ready' });
    fixture.images!.accessValue = 'needs-approval';
    expect(await fixture.service.access()).to.deep.equal({ kind: 'needs-approval' });
    fixture.images!.accessValue = 'no-engine';
    expect(await fixture.service.access()).to.include({ kind: 'unavailable', reason: 'no-engine' });
    fixture.images!.accessValue = 'unsupported';
    expect(await fixture.service.access()).to.deep.equal({ kind: 'provider-outdated' });
    const driver = imageGraphicsDriverBlock(
      'win32',
      'x64',
      { SystemRoot: 'C:\\Windows' },
      () => false,
    );
    fixture.block(driver);
    expect(await fixture.service.access()).to.include({
      kind: 'unavailable',
      reason: 'graphics-driver',
    });
  });

  it('shows the approval code while access is requested, then reports ready', async () => {
    const fixture = setup();
    fixture.images!.accessValue = 'needs-approval';
    const proceed = deferred<void>();
    fixture.images!.approval = async (showCode) => {
      showCode('ABC-123');
      await proceed.promise;
    };
    const seen: AiImageAccess[] = [];
    fixture.service.onAccess((access) => seen.push(access));
    const request = fixture.service.requestAccess();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seen.at(-1)).to.deep.equal({ kind: 'awaiting-approval', verificationCode: 'ABC-123' });
    expect(await fixture.service.access()).to.deep.equal({
      kind: 'awaiting-approval',
      verificationCode: 'ABC-123',
    });
    proceed.resolve();
    expect(await request).to.deep.equal({ ok: true, value: { kind: 'ready' } });
    expect(seen.at(-1)).to.deep.equal({ kind: 'ready' });
  });

  it('keeps a denial an image problem and returns to needs-approval', async () => {
    const fixture = setup();
    fixture.images!.accessValue = 'needs-approval';
    fixture.images!.approval = async () => {
      throw sdkError('user_denied');
    };
    const result = await fixture.service.requestAccess();
    expect(result.ok).to.equal(false);
    if (!result.ok) expect(result.error.code).to.equal('approval-denied');
    expect(await fixture.service.access()).to.deep.equal({ kind: 'needs-approval' });
  });

  it('streams phased progress and ends a render exactly once with owned PNG bytes', async () => {
    const fixture = setup();
    fixture.preferences.value = {
      model: 'sd-cpp:flux-2-klein-4b-q4',
      designModel: null,
      aspect: '16:9',
    };
    fixture.images!.progress = [
      { phase: 'loading_model', step: 49, totalSteps: 298 },
      { phase: 'sampling', step: 2, totalSteps: 4, secondsPerStep: 1.8 },
    ];
    const out = collect<AiImageEvent>();
    fixture.service.startGenerate('1:a', { prompt: 'A lighthouse' }, out.emit);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fixture.images!.lastGenerate?.input).to.deep.equal({
      prompt: 'A lighthouse',
      model: 'sd-cpp:flux-2-klein-4b-q4',
      aspectRatio: '16:9',
    });
    fixture.images!.render.resolve();
    const done = await out.ended;
    expect(out.events.map((event) => event.kind)).to.deep.equal(['progress', 'progress', 'done']);
    expect(out.events[0]).to.deep.equal({
      kind: 'progress',
      progress: { phase: 'loading-model', step: 49, totalSteps: 298, secondsPerStep: null },
    });
    if (done.kind !== 'done') throw new Error('expected done');
    expect(done.image.data).to.be.instanceOf(ArrayBuffer);
    expect(new Uint8Array(done.image.data)).to.deep.equal(PNG);
    expect(done.image).to.include({ width: 1024, height: 768, seed: 7, durationMs: 12_100 });
    expect(fixture.service.activeRenders()).to.equal(0);
  });

  it('cancels a render by aborting the provider call', async () => {
    const fixture = setup();
    const out = collect<AiImageEvent>();
    fixture.service.startGenerate('1:a', { prompt: 'A lighthouse' }, out.emit);
    await new Promise((resolve) => setTimeout(resolve, 5));
    fixture.service.cancelGenerate('1:a');
    const ended = await out.ended;
    expect(ended.kind === 'error' && ended.error.code).to.equal('cancelled');
    expect(fixture.images!.lastGenerate?.signal.aborted).to.equal(true);
  });

  it('turns image failures into image advice and never more than two renders', async () => {
    const fixture = setup();
    fixture.images!.generateError = sdkError(
      'image_capacity',
      'Not enough graphics memory to render this image',
    );
    const failed = collect<AiImageEvent>();
    fixture.service.startGenerate('1:a', { prompt: 'x' }, failed.emit);
    const ended = await failed.ended;
    if (ended.kind !== 'error') throw new Error('expected an error');
    expect(ended.error.code).to.equal('model-unavailable');
    expect(ended.error.message).to.match(/graphics memory/);
    expect(ended.error.detail).to.match(/Not enough graphics memory/);

    fixture.images!.generateError = null;
    const first = collect<AiImageEvent>();
    const second = collect<AiImageEvent>();
    const third = collect<AiImageEvent>();
    fixture.service.startGenerate('1:b', { prompt: 'x' }, first.emit);
    fixture.service.startGenerate('1:c', { prompt: 'x' }, second.emit);
    fixture.service.startGenerate('1:d', { prompt: 'x' }, third.emit);
    const refused = await third.ended;
    expect(refused.kind === 'error' && refused.error.code).to.equal('budget-exceeded');
    fixture.images!.render.resolve();
    expect((await first.ended).kind).to.equal('done');
    expect((await second.ended).kind).to.equal('done');
  });

  it('aborts in-flight work when the connection changes underneath it', async () => {
    const fixture = setup();
    const out = collect<AiImageEvent>();
    fixture.service.startGenerate('1:a', { prompt: 'x' }, out.emit);
    await new Promise((resolve) => setTimeout(resolve, 5));
    fixture.setStatus({ kind: 'unavailable', reason: 'disconnected' }, null);
    const ended = await out.ended;
    expect(ended.kind === 'error' && ended.error.code).to.equal('cancelled');
  });

  it('downloads a model with progress, and cancels the download at the provider', async () => {
    const fixture = setup();
    fixture.images!.ensureEventsScript = [
      { type: 'progress', bytesWritten: 1_000, totalBytes: 4_000 },
      { type: 'done' },
    ];
    const out = collect<AiImageInstallEvent>();
    fixture.service.startInstall('1:i', FLUX.id, out.emit);
    const done = await out.ended;
    expect(out.events[0]).to.deep.equal({
      kind: 'progress',
      progress: { phase: 'downloading', message: 'Downloading the image model…', percent: 25 },
    });
    expect(done.kind === 'done' && done.model.state).to.equal('installed');

    const again = setup();
    again.images!.ensureEventsScript = [{ type: 'progress', bytesWritten: 1, totalBytes: 10 }];
    const stopped = collect<AiImageInstallEvent>();
    again.service.startInstall('1:j', FLUX.id, stopped.emit);
    await new Promise((resolve) => setTimeout(resolve, 10));
    again.service.cancelInstall('1:j');
    const ended = await stopped.ended;
    expect(ended.kind === 'error' && ended.error.code).to.equal('cancelled');
    expect(again.images!.cancelled).to.deep.equal(['flux-job']);
  });

  it('lists models in the provider-neutral shape and forgets a removed preference', async () => {
    const fixture = setup();
    const models = await fixture.service.models();
    expect(models.ok && models.value[0]).to.deep.equal({
      id: FLUX.id,
      label: FLUX.name,
      description: 'A fast model.',
      state: 'download-required',
      downloadBytes: 5_207_178_964,
      shared: false,
      license: 'Apache 2.0',
      commercialUse: true,
      rendersText: true,
      promptStyle: 'sentences',
      hardwareTier: 'high',
      minRamGb: 16,
      fit: { verdict: 'fits', reason: '' },
    });
    fixture.preferences.value = { model: FLUX.id, designModel: FLUX.id, aspect: '1:1' };
    expect(await fixture.service.removeModel(FLUX.id)).to.deep.equal({ ok: true, value: null });
    expect(fixture.preferences.value).to.deep.equal({
      model: null,
      designModel: null,
      aspect: '1:1',
    });
  });
});

describe('ImagePreferenceStore', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'docblocks-image-prefs-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('keeps its own file and falls back to defaults for a foreign one', async () => {
    const file = path.join(root, 'ai', 'images.json');
    const store = new ImagePreferenceStore(file);
    expect(await store.get()).to.deep.equal(DEFAULT_IMAGE_PREFERENCES);
    await store.set({ designModel: 'sd-cpp:ming-image-0.1-design-bf16', aspect: '4:3' });
    expect(JSON.parse(await readFile(file, 'utf8'))).to.deep.equal({
      model: null,
      designModel: 'sd-cpp:ming-image-0.1-design-bf16',
      aspect: '4:3',
    });
    await writeFile(file, '{"aspect":"5:1"}');
    expect(await new ImagePreferenceStore(file).get()).to.deep.equal(DEFAULT_IMAGE_PREFERENCES);
  });
});

describe('imageGraphicsDriverBlock', () => {
  it('asks for a Vulkan-capable driver only on Windows x64 without the loader', () => {
    expect(imageGraphicsDriverBlock('win32', 'x64', {}, () => true)).to.equal(null);
    expect(imageGraphicsDriverBlock('darwin', 'arm64', {}, () => false)).to.equal(null);
    expect(imageGraphicsDriverBlock('win32', 'arm64', {}, () => false)).to.equal(null);
    expect(imageGraphicsDriverBlock('win32', 'x64', {}, () => false)).to.include({
      reason: 'graphics-driver',
    });
  });
});
