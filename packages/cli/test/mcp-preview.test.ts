import { expect } from 'chai';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ArtifactStore } from '../src/mcp/artifact-store.js';
import { McpFileAuthority } from '../src/mcp/authority.js';
import { DocumentService } from '../src/mcp/document-service.js';
import {
  captureWithPlaywright,
  previewPreparedDocument,
  previewVideoSource,
  type PreviewCapture,
  type VideoThumbnailExtractor,
} from '../src/mcp/preview-service.js';

describe('MCP visual preview artifacts', () => {
  let artifacts: ArtifactStore;

  beforeEach(() => {
    artifacts = new ArtifactStore({
      maxArtifactBytes: 1_024,
      maxArtifactTotalBytes: 8_192,
      maxArtifactCount: 16,
      artifactTtlMs: 5_000,
      maxArtifactResourceBytes: 1_024,
    });
  });

  afterEach(async () => artifacts.dispose());

  it('paginates rendered items and publishes exact PNG resources', async () => {
    const authority = await McpFileAuthority.create();
    const documents = new DocumentService(authority, artifacts);
    const prepared = await documents.prepare({
      kind: 'markdown',
      markdown: '# Preview\n\n## First\n\nAlpha\n\n## Second\n\nBeta',
      name: 'preview.md',
    });
    const progress: number[] = [];
    const capture: PreviewCapture = async (_doc, _container, options, signal, onProgress) => {
      expect(signal?.aborted).to.equal(false);
      expect(options).to.deep.equal({ startIndex: 1, maxItems: 2, width: 640, height: 360 });
      await onProgress?.(1, 2, 'captured');
      return {
        totalItems: 5,
        captures: [
          {
            bytes: new Uint8Array([137, 80, 78, 71, 1]),
            index: 1,
            label: 'First',
            width: 640,
            height: 360,
          },
          {
            bytes: new Uint8Array([137, 80, 78, 71, 2]),
            index: 2,
            label: 'Second',
            width: 640,
            height: 360,
          },
        ],
      };
    };

    const result = await previewPreparedDocument(
      artifacts,
      prepared,
      { startIndex: 1, maxItems: 2, width: 640, height: 360 },
      new AbortController().signal,
      (completed) => progress.push(completed),
      capture,
    );

    expect(result).to.include({
      kind: 'preview',
      sourceFormat: 'md',
      previewBasis: 'source-render',
      totalItems: 5,
      truncated: true,
    });
    expect(result.items.map((item) => [item.kind, item.index, item.label])).to.deep.equal([
      ['page', 1, 'First'],
      ['page', 2, 'Second'],
    ]);
    expect(progress).to.deep.equal([1]);
    expect(await artifacts.read(result.items[0]!.artifact.uri)).to.deep.equal(
      Buffer.from([137, 80, 78, 71, 1]),
    );
    expect(result.items[0]!.artifact.suggestedFilename).to.equal('preview-preview-002.png');
    expect(result.items[0]!.artifact.engineVersions.map(({ name }) => name)).to.deep.equal([
      'docblocks',
      '@bendyline/squisq-cli',
    ]);
    expect(result.items[0]!.artifact.engineVersions[1]?.version).to.match(
      /\+runtime\.[a-f0-9]{16}$/u,
    );
  });

  it('marks imported-document previews as reconstructed rather than native pixels', async () => {
    const documents = new DocumentService(await McpFileAuthority.create(), artifacts);
    const prepared = await documents.prepare({
      kind: 'markdown',
      markdown: '# Imported representation',
      name: 'imported.md',
    });
    const result = await previewPreparedDocument(
      artifacts,
      { ...prepared, sourceFormat: 'pptx' },
      { width: 640, height: 360 },
      undefined,
      undefined,
      async () => ({
        totalItems: 1,
        captures: [
          {
            bytes: new Uint8Array([137, 80, 78, 71]),
            index: 0,
            label: 'Slide 1',
            width: 640,
            height: 360,
          },
        ],
      }),
    );

    expect(result.previewBasis).to.equal('reconstructed-import');
    expect(result.diagnostics.find(({ code }) => code === 'preview-reconstructed')).to.include({
      code: 'preview-reconstructed',
      severity: 'warning',
      stage: 'render',
      format: 'pptx',
      count: 1,
      retryable: false,
      location: null,
    });
  });

  it('bounds capture diagnostics with an occurrence-preserving aggregate', async () => {
    const documents = new DocumentService(await McpFileAuthority.create(), artifacts);
    const prepared = await documents.prepare({
      kind: 'markdown',
      markdown: '# Diagnostic bounds',
      name: 'diagnostics.md',
    });
    const result = await previewPreparedDocument(
      artifacts,
      prepared,
      { width: 640, height: 360 },
      undefined,
      undefined,
      async () => ({
        totalItems: 1,
        captures: [
          {
            bytes: new Uint8Array([137, 80, 78, 71]),
            index: 0,
            label: 'Page 1',
            width: 640,
            height: 360,
          },
        ],
        diagnostics: Array.from({ length: 600 }, (_, index) => ({
          code: `preview-diagnostic-${index}`,
          severity: 'warning' as const,
          stage: 'render' as const,
          format: 'md',
          count: 1,
          message: `Preview diagnostic ${index}`,
          remediation: null,
          retryable: false,
          location: null,
        })),
      }),
    );

    expect(result.diagnostics.length).to.be.at.most(500);
    expect(result.diagnostics.find(({ code }) => code === 'diagnostics-truncated')).to.include({
      severity: 'warning',
      stage: 'render',
      count: 103,
    });
  });

  it('honors cancellation before launching the renderer', async () => {
    const authority = await McpFileAuthority.create();
    const documents = new DocumentService(authority, artifacts);
    const prepared = await documents.prepare({
      kind: 'markdown',
      markdown: '# Cancelled',
      name: null,
    });
    const controller = new AbortController();
    controller.abort(new Error('cancelled by client'));
    let captureCalled = false;

    try {
      await previewPreparedDocument(
        artifacts,
        prepared,
        {},
        controller.signal,
        undefined,
        async () => {
          captureCalled = true;
          return { captures: [], totalItems: 0 };
        },
      );
      expect.fail('Expected cancellation');
    } catch (caught: unknown) {
      expect(String(caught)).to.contain('cancelled by client');
    }
    expect(captureCalled).to.equal(false);
  });

  it('closes a browser returned after launch-time cancellation before creating a page', async () => {
    const authority = await McpFileAuthority.create();
    const documents = new DocumentService(authority, artifacts);
    const prepared = await documents.prepare({
      kind: 'markdown',
      markdown: '# Launch cancellation',
      name: null,
    });
    const controller = new AbortController();
    const reason = new Error('cancelled while Chromium launched');
    let browserClosed = false;
    let pageCreated = false;
    const browser = {
      close: async () => {
        browserClosed = true;
      },
      newPage: async () => {
        pageCreated = true;
        throw new Error('A cancelled preview must not create a page');
      },
    } as unknown as import('playwright-core').Browser;

    let caught: unknown;
    try {
      await captureWithPlaywright(
        prepared.doc,
        prepared.container,
        { startIndex: 0, maxItems: 1, width: 640, height: 360 },
        controller.signal,
        undefined,
        async () => {
          controller.abort(reason);
          return browser;
        },
      );
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).to.equal(reason);
    expect(browserClosed).to.equal(true);
    expect(pageCreated).to.equal(false);
  });

  it('rejects preview requests whose pixel budget is too large', async () => {
    const authority = await McpFileAuthority.create();
    const documents = new DocumentService(authority, artifacts);
    const prepared = await documents.prepare({
      kind: 'markdown',
      markdown: '# Budget',
      name: null,
    });
    try {
      await previewPreparedDocument(artifacts, prepared, { width: 1_920, height: 1_920 });
      expect.fail('Expected pixel-budget rejection');
    } catch (caught: unknown) {
      expect(String(caught)).to.contain('pixel area');
    }
  });

  it('rejects injected captures whose cumulative bytes exceed the bounded heap budget', async () => {
    const authority = await McpFileAuthority.create();
    const documents = new DocumentService(authority, artifacts);
    const prepared = await documents.prepare({
      kind: 'markdown',
      markdown: '# Capture bytes',
      name: null,
    });
    const capture: PreviewCapture = async () => ({
      totalItems: 2,
      captures: [
        { bytes: new Uint8Array(3), index: 0, label: null, width: 640, height: 360 },
        { bytes: new Uint8Array(3), index: 1, label: null, width: 640, height: 360 },
      ],
    });

    let caught: unknown;
    try {
      await previewPreparedDocument(artifacts, prepared, {}, undefined, undefined, capture, 5);
    } catch (error: unknown) {
      caught = error;
    }

    expect(String(caught)).to.include('aggregate budget');
    expect(await artifacts.completeIds('')).to.deep.equal([]);
  });

  it('rejects rendered-document aggregate pixels before launching a browser', async () => {
    const authority = await McpFileAuthority.create();
    const documents = new DocumentService(authority, artifacts);
    const markdown = Array.from(
      { length: 70 },
      (_value, index) => `## Visual ${index + 1}\n\nContent ${index + 1}`,
    ).join('\n\n');
    const prepared = await documents.prepare({ kind: 'markdown', markdown, name: null });
    let browserLaunched = false;

    let caught: unknown;
    try {
      await captureWithPlaywright(
        prepared.doc,
        prepared.container,
        { startIndex: 0, maxItems: 70, width: 1_920, height: 1_080 },
        undefined,
        undefined,
        async () => {
          browserLaunched = true;
          throw new Error('Browser must not launch');
        },
      );
    } catch (error: unknown) {
      caught = error;
    }

    expect(String(caught)).to.include('aggregate-pixel budget');
    expect(browserLaunched).to.equal(false);
  });

  it('publishes an exact bounded first-frame JPEG and removes its staging directory', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0xff, 0xd9]);
    const video = Buffer.from('bounded-mp4-fixture');
    let stagingDirectory: string | undefined;
    const progress: number[] = [];
    const extract: VideoThumbnailExtractor = async (options) => {
      stagingDirectory = options.outputDir;
      expect(options.signal?.aborted).to.equal(false);
      expect(options.sizes).to.deep.equal([
        {
          name: 'preview',
          width: 640,
          height: 360,
          filter:
            'scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2',
        },
      ]);
      expect(
        await import('node:fs/promises').then(({ readFile }) => readFile(options.videoPath)),
      ).to.deep.equal(video);
      await writeFile(join(options.outputDir, 'first-frame-640x360.jpg'), jpeg);
    };

    const result = await previewVideoSource(
      artifacts,
      {
        bytes: video,
        filename: 'launch-demo.mp4',
        format: 'mp4',
        sha256: 'a'.repeat(64),
      },
      { width: 640, height: 360 },
      new AbortController().signal,
      (completed) => progress.push(completed),
      extract,
    );

    expect(result).to.include({
      kind: 'preview',
      sourceFormat: 'mp4',
      previewBasis: 'native-extracted',
      totalItems: 1,
      truncated: false,
    });
    expect(result.items).to.have.length(1);
    expect(result.items[0]).to.include({
      kind: 'frame',
      index: 0,
      label: 'First frame',
      width: 640,
      height: 360,
    });
    expect(result.items[0]!.artifact).to.include({
      format: 'jpg',
      mimeType: 'image/jpeg',
      sourceFormat: 'mp4',
      sourceSha256: 'a'.repeat(64),
      suggestedFilename: 'launch-demo-preview-001.jpg',
    });
    expect(await artifacts.read(result.items[0]!.artifact.uri)).to.deep.equal(jpeg);
    expect(progress).to.deep.equal([0, 1, 2, 3]);
    expect(stagingDirectory).to.be.a('string');
    await expectMissing(stagingDirectory!);
  });

  it('preserves cancellation and removes video staging after extraction starts', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel video thumbnail');
    let stagingDirectory: string | undefined;
    const extract: VideoThumbnailExtractor = async (options) => {
      stagingDirectory = options.outputDir;
      controller.abort(reason);
      options.signal?.throwIfAborted();
    };

    let caught: unknown;
    try {
      await previewVideoSource(
        artifacts,
        {
          bytes: Buffer.from('video'),
          filename: 'cancel.mp4',
          format: 'mp4',
          sha256: 'b'.repeat(64),
        },
        {},
        controller.signal,
        undefined,
        extract,
      );
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).to.equal(reason);
    expect(stagingDirectory).to.be.a('string');
    await expectMissing(stagingDirectory!);
  });

  it('discards a video thumbnail artifact when cancellation wins during publication', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel published thumbnail');
    const extract: VideoThumbnailExtractor = async (options) => {
      const size = options.sizes[0]!;
      await writeFile(
        join(options.outputDir, `${options.slug}-${size.width}x${size.height}.jpg`),
        Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      );
    };

    let caught: unknown;
    try {
      await previewVideoSource(
        artifacts,
        {
          bytes: Buffer.from('video'),
          filename: 'cancel.mp4',
          format: 'mp4',
          sha256: 'c'.repeat(64),
        },
        {},
        controller.signal,
        (completed) => {
          if (completed === 3) controller.abort(reason);
        },
        extract,
      );
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).to.equal(reason);
    expect(await artifacts.completeIds('')).to.deep.equal([]);
  });

  it('discards a video thumbnail artifact when final progress reporting fails', async () => {
    const failure = new Error('progress transport closed');
    const extract: VideoThumbnailExtractor = async (options) => {
      const size = options.sizes[0]!;
      await writeFile(
        join(options.outputDir, `${options.slug}-${size.width}x${size.height}.jpg`),
        Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      );
    };

    let caught: unknown;
    try {
      await previewVideoSource(
        artifacts,
        {
          bytes: Buffer.from('video'),
          filename: 'progress.mp4',
          format: 'mp4',
          sha256: 'd'.repeat(64),
        },
        {},
        undefined,
        (completed) => {
          if (completed === 3) throw failure;
        },
        extract,
      );
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).to.equal(failure);
    expect(await artifacts.completeIds('')).to.deep.equal([]);
  });

  it('rolls back earlier preview artifacts when a later publication fails', async () => {
    const constrained = new ArtifactStore({
      maxArtifactBytes: 1_024,
      maxArtifactTotalBytes: 8_192,
      maxArtifactCount: 1,
      artifactTtlMs: 5_000,
    });
    try {
      const documents = new DocumentService(await McpFileAuthority.create(), constrained);
      const prepared = await documents.prepare({
        kind: 'markdown',
        markdown: '# Rollback',
        name: null,
      });
      let caught: unknown;
      try {
        await previewPreparedDocument(
          constrained,
          prepared,
          {},
          undefined,
          undefined,
          async () => ({
            totalItems: 2,
            captures: [
              { bytes: new Uint8Array([1]), index: 0, label: null, width: 640, height: 360 },
              { bytes: new Uint8Array([2]), index: 1, label: null, width: 640, height: 360 },
            ],
          }),
        );
      } catch (error: unknown) {
        caught = error;
      }
      expect(String(caught)).to.include('count limit');
      expect(await constrained.completeIds('')).to.deep.equal([]);
    } finally {
      await constrained.dispose();
    }
  });
});

async function expectMissing(path: string): Promise<void> {
  let exists = true;
  try {
    await access(path);
  } catch {
    exists = false;
  }
  expect(exists).to.equal(false);
}
