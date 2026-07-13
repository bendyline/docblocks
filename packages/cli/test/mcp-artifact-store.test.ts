import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { expect } from 'chai';
import {
  ArtifactStore,
  MCP_ARTIFACT_STORE_LIMITS,
  type ArtifactStoreOptions,
} from '../src/mcp/artifact-store.js';

const artifact = (bytes: Uint8Array, suffix = 'bin') => ({
  bytes,
  format: suffix,
  mimeType: 'application/octet-stream',
  suggestedFilename: `artifact.${suffix}`,
});

describe('MCP artifact store', function () {
  this.timeout(10_000);

  const stores: ArtifactStore[] = [];

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.dispose()));
  });

  it('enforces hard ceilings even when a host supplies larger quota options', () => {
    expect(
      () =>
        new ArtifactStore({
          maxArtifactBytes: MCP_ARTIFACT_STORE_LIMITS.maxArtifactBytes + 1,
          maxArtifactTotalBytes: MCP_ARTIFACT_STORE_LIMITS.maxArtifactTotalBytes,
        }),
    ).to.throw('maximum');
    expect(
      () =>
        new ArtifactStore({
          maxArtifactCount: MCP_ARTIFACT_STORE_LIMITS.maxArtifactCount + 1,
        }),
    ).to.throw('maximum');
    expect(
      () => new ArtifactStore({ artifactTtlMs: MCP_ARTIFACT_STORE_LIMITS.artifactTtlMs + 1 }),
    ).to.throw('maximum');
    expect(
      () =>
        new ArtifactStore({
          maxArtifactReportTotalBytes: MCP_ARTIFACT_STORE_LIMITS.maxArtifactReportTotalBytes + 1,
        }),
    ).to.throw('maximum');
  });

  function createStore(options: ArtifactStoreOptions): ArtifactStore {
    const store = new ArtifactStore(options);
    stores.push(store);
    return store;
  }

  it('returns immutable artifact metadata and the exact stored bytes', async () => {
    const store = createStore({
      maxArtifactBytes: 32,
      maxArtifactTotalBytes: 64,
      maxArtifactCount: 2,
      artifactTtlMs: 5_000,
      maxArtifactResourceBytes: 32,
    });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const ref = await store.put({
      ...artifact(bytes, 'pdf'),
      mimeType: 'application/pdf',
      sourceFormat: 'md',
      sourceSha256: 'a'.repeat(64),
      appliedOptions: [{ name: 'themeId', value: 'documentary' }],
      engineVersions: [{ name: 'squisq', version: 'linked' }],
    });

    expect(ref.uri).to.equal(`docblocks://artifacts/${ref.id}`);
    expect(ref).to.include({
      format: 'pdf',
      mimeType: 'application/pdf',
      size: bytes.byteLength,
      sourceFormat: 'md',
      sourceSha256: 'a'.repeat(64),
      suggestedFilename: 'artifact.pdf',
    });
    expect(ref.sha256).to.equal(createHash('sha256').update(bytes).digest('hex'));
    expect(Date.parse(ref.expiresAt ?? '')).to.be.greaterThan(Date.parse(ref.createdAt));
    expect(Buffer.from(await store.read(ref.id))).to.deep.equal(Buffer.from(bytes));
    expect(await store.get(ref.uri)).to.deep.equal(ref);

    const report = {
      version: 1 as const,
      kind: 'conversion' as const,
      sourceFormat: 'md',
      targetFormat: 'pdf',
      artifact: ref,
      fidelity: 'semantic' as const,
      appliedThemeId: 'documentary',
      appliedTransformId: null,
      sourceAssets: [],
      sourceAssetCount: 0,
      diagnostics: [],
    };
    await store.attachConversionReport(report);
    expect(await store.getConversionReport(ref.uri)).to.deep.equal(report);
  });

  it('clones and freezes caller metadata so mutation cannot corrupt quota accounting', async () => {
    const store = createStore({
      maxArtifactBytes: 4,
      maxArtifactTotalBytes: 4,
      maxArtifactCount: 1,
      artifactTtlMs: 5_000,
      maxArtifactResourceBytes: 4,
    });
    const appliedOptions = [{ name: 'themeId', value: 'documentary' }];
    const engineVersions = [{ name: 'squisq', version: 'linked' }];
    const ref = await store.put({
      ...artifact(new Uint8Array([1, 2, 3, 4])),
      appliedOptions,
      engineVersions,
    });

    appliedOptions[0]!.value = 'caller-mutated';
    appliedOptions.push({ name: 'injected', value: 'true' });
    engineVersions[0]!.version = 'caller-mutated';
    engineVersions.push({ name: 'injected', version: '0.0.0' });

    expect(ref.appliedOptions).to.deep.equal([{ name: 'themeId', value: 'documentary' }]);
    expect(ref.engineVersions).to.deep.equal([{ name: 'squisq', version: 'linked' }]);
    expect(Object.isFrozen(ref)).to.equal(true);
    expect(Object.isFrozen(ref.appliedOptions)).to.equal(true);
    expect(Object.isFrozen(ref.appliedOptions[0])).to.equal(true);
    expect(Object.isFrozen(ref.engineVersions)).to.equal(true);
    expect(Object.isFrozen(ref.engineVersions[0])).to.equal(true);
    expect(Reflect.set(ref, 'size', 0)).to.equal(false);
    expect(Reflect.set(ref.appliedOptions[0]!, 'value', 'metadata-poisoned')).to.equal(false);
    expect(Reflect.set(ref.engineVersions[0]!, 'version', 'metadata-poisoned')).to.equal(false);

    const fetched = await store.get(ref.uri);
    const resource = await store.readResource(ref.uri);
    expect(fetched).to.equal(ref);
    expect(resource.ref).to.equal(ref);
    expect(Object.isFrozen(fetched)).to.equal(true);

    await store.discard(ref.uri);
    const replacement = await store.put(artifact(new Uint8Array([5, 6, 7, 8])));
    expect(await store.get(replacement.uri)).to.equal(replacement);
  });

  it('enforces per-artifact and aggregate byte budgets without consuming capacity on failure', async () => {
    const store = createStore({
      maxArtifactBytes: 6,
      maxArtifactTotalBytes: 8,
      maxArtifactCount: 4,
      artifactTtlMs: 5_000,
      maxArtifactResourceBytes: 6,
    });

    await expectFailure(store.put(artifact(new Uint8Array(7))), 'per-artifact');
    const first = await store.put(artifact(new Uint8Array(5)));
    await expectFailure(store.put(artifact(new Uint8Array(4))), 'total-byte');

    expect(await store.get(first.id)).to.deep.equal(first);
    expect(Buffer.from(await store.read(first.id))).to.have.length(5);
  });

  it('serializes concurrent puts so the count limit cannot be overcommitted', async () => {
    const store = createStore({
      maxArtifactBytes: 8,
      maxArtifactTotalBytes: 8,
      maxArtifactCount: 1,
      artifactTtlMs: 5_000,
      maxArtifactResourceBytes: 8,
    });

    const settled = await Promise.allSettled([
      store.put(artifact(new Uint8Array([1]))),
      store.put(artifact(new Uint8Array([2]))),
      store.put(artifact(new Uint8Array([3]))),
    ]);
    const fulfilled = settled.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<ArtifactStore['put']>>> =>
        result.status === 'fulfilled',
    );
    const rejected = settled.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    expect(fulfilled).to.have.length(1);
    expect(rejected).to.have.length(2);
    for (const result of rejected) {
      expect(String(result.reason)).to.include('count limit');
    }
    expect(await store.completeIds('')).to.deep.equal([fulfilled[0].value.id]);
  });

  it('expires artifacts, removes them from completion, and releases their quotas', async () => {
    const store = createStore({
      maxArtifactBytes: 4,
      maxArtifactTotalBytes: 4,
      maxArtifactCount: 1,
      artifactTtlMs: 15,
      maxArtifactResourceBytes: 4,
    });
    const expired = await store.put(artifact(new Uint8Array([1, 2, 3, 4])));
    const remaining = Math.max(0, Date.parse(expired.expiresAt ?? '') - Date.now());
    await delay(remaining + 10);

    await expectFailure(store.get(expired.uri), 'unknown or expired');
    expect(await store.completeIds('')).to.deep.equal([]);
    const replacement = await store.put(artifact(new Uint8Array([5, 6, 7, 8])));
    expect(await store.get(replacement.id)).to.deep.equal(replacement);
  });

  it('bounds resource responses independently of artifact storage and materialization reads', async () => {
    const store = createStore({
      maxArtifactBytes: 8,
      maxArtifactTotalBytes: 8,
      maxArtifactCount: 1,
      artifactTtlMs: 5_000,
      maxArtifactResourceBytes: 3,
    });
    const ref = await store.put(artifact(new Uint8Array([1, 2, 3, 4])));

    await expectFailure(store.readResource(ref.uri), 'too large');
    expect(Buffer.from(await store.read(ref.uri))).to.deep.equal(Buffer.from([1, 2, 3, 4]));
  });

  it('isolates opaque artifact URIs between server sessions', async () => {
    const options = {
      maxArtifactBytes: 8,
      maxArtifactTotalBytes: 8,
      maxArtifactCount: 1,
      artifactTtlMs: 5_000,
      maxArtifactResourceBytes: 8,
    };
    const first = createStore(options);
    const second = createStore(options);
    const ref = await first.put(artifact(new Uint8Array([9])));

    await expectFailure(second.get(ref.uri), 'unknown or expired');
    await expectFailure(second.read(ref.id), 'unknown or expired');
    expect(
      Buffer.from(await first.readResource(ref.uri).then((result) => result.bytes)),
    ).to.deep.equal(Buffer.from([9]));
  });

  it('aborts active byte reads without holding disposal behind stalled I/O', async () => {
    for (const resourceRead of [false, true]) {
      let markReadStarted: () => void = () => undefined;
      const readStarted = new Promise<void>((resolve) => {
        markReadStarted = resolve;
      });
      let releaseRead: () => void = () => undefined;
      const readReleased = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      const store = new ArtifactStore(
        {
          maxArtifactBytes: 8,
          maxArtifactTotalBytes: 8,
          maxArtifactCount: 1,
          artifactTtlMs: 5_000,
          maxArtifactResourceBytes: 8,
        },
        {
          readFile: async (path, options) => {
            const bytes = await readFile(path);
            markReadStarted();
            await readReleased;
            expect(options.signal.aborted).to.equal(true);
            return bytes;
          },
        },
      );
      stores.push(store);
      const expected = Buffer.from([1, 2, 3, 4]);
      const ref = await store.put(artifact(expected));

      const readPromise = resourceRead
        ? store.readResource(ref.uri).then(({ bytes }) => bytes)
        : store.read(ref.uri);
      await readStarted;
      const disposeStarted = Date.now();
      await store.dispose();
      expect(Date.now() - disposeStarted).to.be.lessThan(1_000);
      releaseRead();
      await expectFailure(readPromise, 'disposed');
    }
  });

  it('forwards exact caller cancellation through artifact and resource reads', async () => {
    for (const resourceRead of [false, true]) {
      let markReadStarted: () => void = () => undefined;
      const readStarted = new Promise<void>((resolve) => {
        markReadStarted = resolve;
      });
      const store = new ArtifactStore(
        {
          maxArtifactBytes: 8,
          maxArtifactTotalBytes: 8,
          maxArtifactCount: 1,
          artifactTtlMs: 5_000,
          maxArtifactResourceBytes: 8,
        },
        {
          readFile: async (_path, options) => {
            markReadStarted();
            return new Promise<Buffer>((_resolve, reject) => {
              const rejectAborted = (): void =>
                reject(options.signal.reason ?? new Error('read aborted'));
              if (options.signal.aborted) rejectAborted();
              else options.signal.addEventListener('abort', rejectAborted, { once: true });
            });
          },
        },
      );
      stores.push(store);
      const ref = await store.put(artifact(new Uint8Array([1, 2, 3, 4])));
      const cancellation = new Error(
        resourceRead ? 'cancel artifact resource read' : 'cancel artifact byte read',
      );
      const controller = new AbortController();
      const readPromise = resourceRead
        ? store.readResource(ref.uri, controller.signal)
        : store.read(ref.uri, controller.signal);
      await readStarted;
      controller.abort(cancellation);
      await expectExactFailure(readPromise, cancellation);
    }
  });

  it('cancels a stalled put, cleans its reservation, and allows a later artifact', async () => {
    const cancellation = new Error('cancel stalled artifact write');
    const controller = new AbortController();
    let markWriteStarted: () => void = () => undefined;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    let first = true;
    let cancelledPath: string | null = null;
    const store = new ArtifactStore(
      {
        maxArtifactBytes: 8,
        maxArtifactTotalBytes: 8,
        maxArtifactCount: 1,
        artifactTtlMs: 5_000,
        maxArtifactResourceBytes: 8,
      },
      {
        writeFile: async (path, bytes, signal) => {
          if (!first) {
            await writeFile(path, bytes, { flag: 'wx' });
            return;
          }
          first = false;
          cancelledPath = path;
          await writeFile(path, bytes.subarray(0, 2), { flag: 'wx' });
          markWriteStarted();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(signal.reason ?? new Error('write aborted')),
              { once: true },
            );
          });
        },
      },
    );
    stores.push(store);

    const putPromise = store.put(artifact(new Uint8Array([1, 2, 3, 4])), controller.signal);
    await writeStarted;
    controller.abort(cancellation);
    await expectExactFailure(putPromise, cancellation);
    if (!cancelledPath) throw new Error('Expected a staged artifact path');
    await expectFailure(readFile(cancelledPath), 'no such file');

    const replacement = await store.put(artifact(new Uint8Array([5, 6, 7, 8])));
    expect(await store.read(replacement.uri)).to.deep.equal(Buffer.from([5, 6, 7, 8]));
  });

  it('bounds disposal when a write dependency ignores cancellation', async () => {
    let markWriteStarted: () => void = () => undefined;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    let releaseWrite: () => void = () => undefined;
    const writeReleased = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let observedSignal: AbortSignal | null = null;
    const store = new ArtifactStore(
      {
        maxArtifactBytes: 8,
        maxArtifactTotalBytes: 8,
        maxArtifactCount: 1,
        artifactTtlMs: 5_000,
        maxArtifactResourceBytes: 8,
      },
      {
        writeFile: async (_path, _bytes, signal) => {
          observedSignal = signal;
          markWriteStarted();
          await writeReleased;
        },
      },
    );
    stores.push(store);

    const putPromise = store.put(artifact(new Uint8Array([1, 2, 3, 4])));
    await writeStarted;
    const disposeStarted = Date.now();
    await store.dispose();
    expect(Date.now() - disposeStarted).to.be.lessThan(1_000);
    expect(observedSignal?.aborted).to.equal(true);
    releaseWrite();
    await expectFailure(putPromise, 'disposed');
  });

  it('rejects malformed artifact URIs and permanently rejects work after disposal', async () => {
    const store = createStore({
      maxArtifactBytes: 8,
      maxArtifactTotalBytes: 8,
      maxArtifactCount: 1,
      artifactTtlMs: 5_000,
      maxArtifactResourceBytes: 8,
    });

    for (const uri of [
      'not-a-uri',
      'docblocks://other/00000000-0000-4000-8000-000000000000',
      'docblocks://artifacts/00000000-0000-4000-8000-000000000000?secret=1',
      'docblocks://user@artifacts/00000000-0000-4000-8000-000000000000',
      'docblocks://artifacts:123/00000000-0000-4000-8000-000000000000',
      'docblocks://artifacts//00000000-0000-4000-8000-000000000000',
      '00000000-0000-4000-8000-00000000000A',
    ]) {
      await expectFailure(store.get(uri), 'invalid');
    }

    await store.dispose();
    await store.dispose();
    await expectFailure(store.put(artifact(new Uint8Array([1]))), 'disposed');
    await expectFailure(store.completeIds(''), 'disposed');
  });

  it('bounds reports and releases artifact quotas when unpublished output is discarded', async () => {
    const store = createStore({
      maxArtifactBytes: 8,
      maxArtifactTotalBytes: 8,
      maxArtifactCount: 1,
      artifactTtlMs: 5_000,
      maxArtifactResourceBytes: 8,
      maxArtifactReportBytes: 128,
    });
    const ref = await store.put(artifact(new Uint8Array([1])));
    const oversized = {
      version: 1 as const,
      kind: 'conversion' as const,
      sourceFormat: 'md',
      targetFormat: 'bin',
      artifact: ref,
      fidelity: 'semantic' as const,
      appliedThemeId: null,
      appliedTransformId: null,
      sourceAssets: [],
      sourceAssetCount: 0,
      diagnostics: [],
    };
    await expectFailure(store.attachConversionReport(oversized), 'report exceeds');
    await store.discard(ref.uri);
    const replacement = await store.put(artifact(new Uint8Array([2])));
    expect(await store.get(replacement.uri)).to.deep.equal(replacement);
  });

  it('bounds aggregate report retention and releases it with the owning artifact', async () => {
    const store = createStore({
      maxArtifactBytes: 8,
      maxArtifactTotalBytes: 8,
      maxArtifactCount: 2,
      artifactTtlMs: 5_000,
      maxArtifactResourceBytes: 8,
      maxArtifactReportBytes: 1_024,
      maxArtifactReportTotalBytes: 1_024,
    });
    const first = await store.put(artifact(new Uint8Array([1])));
    const second = await store.put(artifact(new Uint8Array([2])));
    const reportFor = (ref: typeof first) => ({
      version: 1 as const,
      kind: 'conversion' as const,
      sourceFormat: 'md',
      targetFormat: ref.format,
      artifact: ref,
      fidelity: 'semantic' as const,
      appliedThemeId: null,
      appliedTransformId: null,
      sourceAssets: [],
      sourceAssetCount: 0,
      diagnostics: [],
    });

    await store.attachConversionReport(reportFor(first));
    await expectFailure(store.attachConversionReport(reportFor(second)), 'aggregate');
    await store.discard(first.uri);
    await store.attachConversionReport(reportFor(second));
    expect(await store.getConversionReport(second.uri)).to.deep.equal(reportFor(second));
  });
});

async function expectFailure(promise: Promise<unknown>, message: string): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (caught: unknown) {
    error = caught;
  }
  expect(error).to.be.instanceOf(Error);
  expect((error as Error).message.toLowerCase()).to.contain(message.toLowerCase());
}

async function expectExactFailure(promise: Promise<unknown>, expected: unknown): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (caught: unknown) {
    error = caught;
  }
  expect(error).to.equal(expected);
}
