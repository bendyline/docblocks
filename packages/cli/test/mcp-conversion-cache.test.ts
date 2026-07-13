import { expect } from 'chai';
import JSZip from 'jszip';
import {
  parseConversionResult,
  type ArtifactRef,
  type AssetSummary,
  type EngineVersion,
} from '@bendyline/docblocks/mcp';
import { ArtifactStore } from '../src/mcp/artifact-store.js';
import { McpFileAuthority } from '../src/mcp/authority.js';
import {
  convertPreparedDocument,
  createConversionCacheKey,
  type ConversionRequestOptions,
  type ConversionServiceDependencies,
  type ConversionTargetRequest,
} from '../src/mcp/conversion-service.js';
import { DocumentService, type PreparedDocument } from '../src/mcp/document-service.js';

const MULTI_TARGET_REQUEST: ConversionRequestOptions = {
  targets: [
    { format: 'md', fidelity: 'semantic' },
    { format: 'dbk', fidelity: 'editable-native' },
  ],
};

describe('MCP completed conversion cache', () => {
  it('routes rendered targets separately, prepares native misses once, and skips cached work', async () => {
    const artifacts = new ArtifactStore();
    let prepareCount = 0;
    let renderedCount = 0;
    const exportedTargets: string[] = [];
    const optionMarkers: string[] = [];
    const prepareNativeConversion: ConversionServiceDependencies['prepareNativeConversion'] =
      async (source, options) => {
        prepareCount += 1;
        expect(source.kind).to.equal('markdown');
        expect(options.themeId).to.equal('cinematic');
        expect(options.transformStyle).to.equal('magazine');
        expect(options.autoTemplates).to.equal(true);
        return {
          async convert(format, targetOptions) {
            exportedTargets.push(format);
            const formatOptions = targetOptions?.formatOptions?.[format] as
              | { marker?: unknown }
              | undefined;
            optionMarkers.push(String(formatOptions?.marker));
            const bytes =
              format === 'dbk'
                ? await new JSZip()
                    .file('index.md', '# Prepared DBK')
                    .generateAsync({ type: 'uint8array', compression: 'STORE' })
                : new TextEncoder().encode(`prepared:${format}`);
            return {
              bytes,
              mimeType: format === 'md' ? 'text/markdown' : 'application/vnd.docblocks+zip',
              suggestedFilename: `staged.${format}`,
              warnings: [`${format} staged`],
            };
          },
        };
      };
    const dependencies: ConversionServiceDependencies = {
      prepareNativeConversion,
      async convertRenderedDocument(_prepared, format) {
        renderedCount += 1;
        return {
          bytes: new TextEncoder().encode(`rendered:${format}`),
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          suggestedFilename: 'staged.pptx',
          warnings: ['pptx rendered'],
        };
      },
    };
    const request: ConversionRequestOptions = {
      themeId: 'cinematic',
      transformId: 'magazine',
      autoTemplates: true,
      targets: [
        { format: 'pptx', fidelity: 'rendered-fidelity' },
        { format: 'md', fidelity: 'semantic', options: { marker: 'first' } },
        { format: 'dbk', fidelity: 'editable-native', options: { marker: 'second' } },
      ],
    };

    try {
      const prepared = await prepare(artifacts, '# Prepared once');
      const first = await convertPreparedDocument(
        artifacts,
        prepared,
        request,
        undefined,
        undefined,
        dependencies,
      );
      const cached = await convertPreparedDocument(
        artifacts,
        prepared,
        request,
        undefined,
        undefined,
        dependencies,
      );

      expect(prepareCount).to.equal(1);
      expect(renderedCount).to.equal(1);
      expect(exportedTargets).to.deep.equal(['md', 'dbk']);
      expect(optionMarkers).to.deep.equal(['first', 'second']);
      expect(first.map((result) => result.targetFormat)).to.deep.equal(['pptx', 'md', 'dbk']);
      expect(cached[0]).to.equal(first[0]);
      expect(cached[1]).to.equal(first[1]);
      expect(cached[2]).to.equal(first[2]);
    } finally {
      await artifacts.dispose();
    }
  });

  it('reuses an existing immutable artifact per session with monotonic progress', async () => {
    const artifacts = new ArtifactStore();
    const otherSession = new ArtifactStore();
    try {
      const prepared = await prepare(artifacts, '# Cached\n\nStable content.');
      const firstProgress: number[] = [];
      const first = await convertPreparedDocument(
        artifacts,
        prepared,
        MULTI_TARGET_REQUEST,
        undefined,
        (completed) => firstProgress.push(completed),
      );
      const cachedProgress: number[] = [];
      const cached = await convertPreparedDocument(
        artifacts,
        prepared,
        MULTI_TARGET_REQUEST,
        undefined,
        (completed) => cachedProgress.push(completed),
      );

      expect(cached).to.have.length(2);
      expect(cached[0]).to.equal(first[0]);
      expect(cached[1]).to.equal(first[1]);
      expect(cached.map(({ artifact }) => artifact.uri)).to.deep.equal(
        first.map(({ artifact }) => artifact.uri),
      );
      expect(cached.every((result) => parseConversionResult(result) !== null)).to.equal(true);
      expect(Object.isFrozen(cached[0])).to.equal(true);
      expect(Object.isFrozen(cached[0]?.artifact)).to.equal(true);
      expect(Object.isFrozen(cached[0]?.artifact.engineVersions)).to.equal(true);
      expect(Object.isFrozen(cached[0]?.sourceAssets)).to.equal(true);
      expect(Object.isFrozen(cached[0]?.diagnostics)).to.equal(true);
      expect(isMonotonic(firstProgress), JSON.stringify(firstProgress)).to.equal(true);
      expect(isMonotonic(cachedProgress), JSON.stringify(cachedProgress)).to.equal(true);
      expect(cachedProgress).to.deep.equal([0, 1, 1, 2]);

      const otherPrepared = await prepare(otherSession, '# Cached\n\nStable content.');
      const other = await convertPreparedDocument(
        otherSession,
        otherPrepared,
        MULTI_TARGET_REQUEST,
      );
      expect(other[0]?.artifact.uri).to.not.equal(first[0]?.artifact.uri);
    } finally {
      await Promise.all([artifacts.dispose(), otherSession.dispose()]);
    }
  });

  it('keys every source, engine, target, and request input canonically', () => {
    const sourceAsset: AssetSummary = {
      path: 'media/chart.png' as AssetSummary['path'],
      mimeType: 'image/png',
      size: 4,
      sha256: 'a'.repeat(64),
      altText: 'Quarterly chart',
      credit: 'DocBlocks',
      license: 'CC-BY-4.0',
    };
    const prepared: Pick<
      PreparedDocument,
      'sourceSha256' | 'sourceFormat' | 'baseName' | 'assets' | 'diagnostics'
    > = {
      sourceSha256: 'b'.repeat(64),
      sourceFormat: 'md',
      baseName: 'report',
      assets: [sourceAsset],
      diagnostics: [],
    };
    const request: Omit<ConversionRequestOptions, 'targets'> = {
      themeId: 'documentary',
      transformId: 'magazine',
      autoTemplates: true,
      title: 'Quarterly report',
    };
    const target: ConversionTargetRequest = {
      format: 'dbk',
      fidelity: 'semantic',
      options: { alpha: 1, enabled: true },
    };
    const engines: EngineVersion[] = [
      { name: 'docblocks', version: '1.1.2' },
      { name: '@bendyline/squisq-cli', version: '2.0.0' },
    ];
    const key = createConversionCacheKey(prepared, request, target, 'semantic', engines);
    const changed = (
      source: typeof prepared,
      nextRequest: typeof request,
      nextTarget: ConversionTargetRequest,
      fidelity: 'semantic' | 'editable-native',
      nextEngines: readonly EngineVersion[],
    ) => createConversionCacheKey(source, nextRequest, nextTarget, fidelity, nextEngines);

    expect(
      changed({ ...prepared, sourceSha256: 'c'.repeat(64) }, request, target, 'semantic', engines),
    ).to.not.equal(key);
    expect(
      changed(
        { ...prepared, assets: [{ ...sourceAsset, altText: 'Different exact manifest' }] },
        request,
        target,
        'semantic',
        engines,
      ),
    ).to.not.equal(key);
    expect(
      changed(prepared, request, target, 'semantic', [
        engines[0]!,
        { ...engines[1]!, version: '2.0.1' },
      ]),
    ).to.not.equal(key);
    expect(
      changed(prepared, request, { ...target, format: 'md' }, 'semantic', engines),
    ).to.not.equal(key);
    expect(changed(prepared, request, target, 'editable-native', engines)).to.not.equal(key);
    expect(
      changed(
        prepared,
        request,
        { ...target, options: { alpha: 2, enabled: true } },
        'semantic',
        engines,
      ),
    ).to.not.equal(key);
    for (const nextRequest of [
      { ...request, themeId: 'cinematic' },
      { ...request, transformId: 'data-driven' },
      { ...request, autoTemplates: false },
      { ...request, title: 'Different title' },
    ]) {
      expect(changed(prepared, nextRequest, target, 'semantic', engines)).to.not.equal(key);
    }
    expect(
      changed(
        prepared,
        request,
        { ...target, options: { enabled: true, alpha: 1 } },
        'semantic',
        engines,
      ),
    ).to.equal(key);
  });

  it('checks cancellation before and after validating a cached artifact', async () => {
    const artifacts = new GatedArtifactStore();
    try {
      const prepared = await prepare(artifacts, '# Cancellation');
      const request: ConversionRequestOptions = {
        targets: [{ format: 'md', fidelity: 'semantic' }],
      };
      const [prime] = await convertPreparedDocument(artifacts, prepared, request);

      const before = new AbortController();
      const beforeReason = new Error('cancelled before cache lookup');
      before.abort(beforeReason);
      await expectRejectedReason(
        convertPreparedDocument(artifacts, prepared, request, before.signal),
        beforeReason,
      );

      const gate = artifacts.gateNextGet();
      const after = new AbortController();
      const pending = convertPreparedDocument(artifacts, prepared, request, after.signal);
      await gate.entered;
      const afterReason = new Error('cancelled after cache lookup');
      after.abort(afterReason);
      gate.release();
      await expectRejectedReason(pending, afterReason);

      const [stillCached] = await convertPreparedDocument(artifacts, prepared, request);
      expect(stillCached).to.equal(prime);
    } finally {
      await artifacts.dispose();
    }
  });

  it('never shares an in-flight conversion promise', async () => {
    const artifacts = new ArtifactStore();
    const gate = deferred<void>();
    const started = deferred<void>();
    try {
      const prepared = await prepare(artifacts, '# Concurrent');
      const request: ConversionRequestOptions = {
        targets: [{ format: 'md', fidelity: 'semantic' }],
      };
      let blocked = false;
      const firstPromise = convertPreparedDocument(
        artifacts,
        prepared,
        request,
        undefined,
        async (completed) => {
          if (completed !== 0 || blocked) return;
          blocked = true;
          started.resolve();
          await gate.promise;
        },
      );
      await started.promise;
      const [second] = await convertPreparedDocument(artifacts, prepared, request);
      gate.resolve();
      const [first] = await firstPromise;

      expect(first?.artifact.uri).to.not.equal(second?.artifact.uri);
      const [latest] = await convertPreparedDocument(artifacts, prepared, request);
      expect(latest).to.equal(first);
    } finally {
      gate.resolve();
      await artifacts.dispose();
    }
  });

  it('rolls back earlier artifacts and cache entries when a later target fails', async () => {
    const artifacts = new ArtifactStore();
    const dependencies: ConversionServiceDependencies = {
      async prepareNativeConversion() {
        return {
          async convert(format) {
            if (format === 'pdf') throw new Error('injected second-target failure');
            return {
              bytes: new TextEncoder().encode(`# ${format}`),
              mimeType: 'text/markdown',
              suggestedFilename: `rollback.${format}`,
              warnings: [],
            };
          },
        };
      },
      async convertRenderedDocument() {
        throw new Error('rendered conversion was not expected');
      },
    };
    try {
      const prepared = await prepare(artifacts, '# Transaction');
      let caught: unknown;
      try {
        await convertPreparedDocument(
          artifacts,
          prepared,
          {
            targets: [
              { format: 'md', fidelity: 'semantic' },
              { format: 'pdf', fidelity: 'semantic' },
            ],
          },
          undefined,
          undefined,
          dependencies,
        );
      } catch (error: unknown) {
        caught = error;
      }
      expect(String(caught)).to.include('second-target failure');
      expect(await artifacts.completeIds('')).to.deep.equal([]);
    } finally {
      await artifacts.dispose();
    }
  });

  it('rolls back artifact and report quotas when report attachment fails after put', async () => {
    // Every quota can retain exactly one successful tiny conversion. The
    // first attempt deliberately produces an oversized report only after its
    // artifact bytes have entered the store; the second identical request can
    // succeed only if the failed lifecycle released all accounting.
    const artifacts = new TrackingArtifactStore({
      maxArtifactBytes: 16,
      maxArtifactTotalBytes: 16,
      maxArtifactCount: 1,
      maxArtifactReportBytes: 2_048,
      maxArtifactReportTotalBytes: 2_048,
    });
    let conversionCount = 0;
    const dependencies: ConversionServiceDependencies = {
      async prepareNativeConversion() {
        return {
          async convert() {
            conversionCount += 1;
            return {
              bytes: new TextEncoder().encode(`attempt-${conversionCount}`),
              mimeType: 'text/markdown',
              suggestedFilename: 'report-quota.md',
              warnings:
                conversionCount === 1
                  ? Array.from(
                      { length: 64 },
                      (_, index) => `oversized report warning ${index}: ${'x'.repeat(128)}`,
                    )
                  : [],
            };
          },
        };
      },
      async convertRenderedDocument() {
        throw new Error('rendered conversion was not expected');
      },
    };
    const request: ConversionRequestOptions = {
      targets: [{ format: 'md', fidelity: 'semantic' }],
    };

    try {
      const prepared = await prepare(artifacts, '# Report quota rollback');
      let caught: unknown;
      try {
        await convertPreparedDocument(
          artifacts,
          prepared,
          request,
          undefined,
          undefined,
          dependencies,
        );
      } catch (error: unknown) {
        caught = error;
      }

      expect(String(caught)).to.include('conversion report exceeds the configured byte limit');
      expect(conversionCount).to.equal(1);
      expect(artifacts.putCount).to.equal(1);
      expect(artifacts.attachAttempts).to.equal(1);
      expect(artifacts.discardAttempts).to.be.greaterThan(0);
      expect(artifacts.getCount).to.equal(0);
      expect(await artifacts.completeIds('')).to.deep.equal([]);

      const [successful] = await convertPreparedDocument(
        artifacts,
        prepared,
        request,
        undefined,
        undefined,
        dependencies,
      );
      expect(conversionCount).to.equal(2);
      expect(artifacts.putCount).to.equal(2);
      expect(artifacts.attachAttempts).to.equal(2);
      // A retained failed cache entry would probe its now-discarded artifact
      // before this retry. No get means the failed output was never cached.
      expect(artifacts.getCount).to.equal(0);
      expect(await artifacts.completeIds('')).to.have.length(1);
      expect(await artifacts.read(successful!.artifact.uri)).to.deep.equal(
        Buffer.from('attempt-2'),
      );
      expect(await artifacts.getConversionReport(successful!.artifact.uri)).to.deep.equal(
        successful,
      );

      const [cached] = await convertPreparedDocument(
        artifacts,
        prepared,
        request,
        undefined,
        undefined,
        dependencies,
      );
      expect(cached).to.equal(successful);
      expect(conversionCount).to.equal(2);
      expect(artifacts.getCount).to.equal(1);
    } finally {
      await artifacts.dispose();
    }
  });

  it('evicts stale artifacts and bounds completed entries to the default artifact count', async () => {
    const expiring = new ArtifactStore({ artifactTtlMs: 1 });
    try {
      const prepared = await prepare(expiring, '# Expiring');
      const request: ConversionRequestOptions = {
        targets: [{ format: 'md', fidelity: 'semantic' }],
      };
      const [first] = await convertPreparedDocument(expiring, prepared, request);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const [replacement] = await convertPreparedDocument(expiring, prepared, request);
      expect(replacement?.artifact.uri).to.not.equal(first?.artifact.uri);
    } finally {
      await expiring.dispose();
    }

    const bounded = new ArtifactStore({ maxArtifactCount: 80 });
    try {
      const prepared = await prepare(bounded, '# LRU');
      const requestFor = (variant: number): ConversionRequestOptions => ({
        targets: [
          {
            format: 'md',
            fidelity: 'semantic',
            options: { cacheVariant: variant },
          },
        ],
      });
      const [oldest] = await convertPreparedDocument(bounded, prepared, requestFor(0));
      for (let variant = 1; variant <= 64; variant += 1) {
        await convertPreparedDocument(bounded, prepared, requestFor(variant));
      }
      const [afterEviction] = await convertPreparedDocument(bounded, prepared, requestFor(0));
      expect(afterEviction?.artifact.uri).to.not.equal(oldest?.artifact.uri);
    } finally {
      await bounded.dispose();
    }
  });
});

async function prepare(artifacts: ArtifactStore, markdown: string): Promise<PreparedDocument> {
  const documents = new DocumentService(await McpFileAuthority.create(), artifacts);
  return documents.prepare({ kind: 'markdown', markdown, name: 'cache.md' });
}

function isMonotonic(values: readonly number[]): boolean {
  return values.every((value, index) => index === 0 || value >= values[index - 1]!);
}

async function expectRejectedReason(promise: Promise<unknown>, reason: Error): Promise<void> {
  try {
    await promise;
    expect.fail('Expected operation cancellation');
  } catch (caught: unknown) {
    expect(caught).to.equal(reason);
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value?: T): void;
} {
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value?: T) => resolvePromise(value as T),
  };
}

class GatedArtifactStore extends ArtifactStore {
  private nextGetGate: {
    entered: ReturnType<typeof deferred<void>>;
    release: ReturnType<typeof deferred<void>>;
  } | null = null;

  public gateNextGet(): { entered: Promise<void>; release(): void } {
    const entered = deferred<void>();
    const release = deferred<void>();
    this.nextGetGate = { entered, release };
    return { entered: entered.promise, release: () => release.resolve() };
  }

  public override async get(uriOrId: string): Promise<ArtifactRef> {
    const gate = this.nextGetGate;
    if (gate) {
      this.nextGetGate = null;
      gate.entered.resolve();
      await gate.release.promise;
    }
    return super.get(uriOrId);
  }
}

class TrackingArtifactStore extends ArtifactStore {
  public putCount = 0;
  public attachAttempts = 0;
  public discardAttempts = 0;
  public getCount = 0;

  public override async put(options: Parameters<ArtifactStore['put']>[0]): Promise<ArtifactRef> {
    const result = await super.put(options);
    this.putCount += 1;
    return result;
  }

  public override async attachConversionReport(
    report: Parameters<ArtifactStore['attachConversionReport']>[0],
  ): Promise<void> {
    this.attachAttempts += 1;
    return super.attachConversionReport(report);
  }

  public override async discard(uriOrId: string): Promise<void> {
    this.discardAttempts += 1;
    return super.discard(uriOrId);
  }

  public override async get(uriOrId: string): Promise<ArtifactRef> {
    this.getCount += 1;
    return super.get(uriOrId);
  }
}
