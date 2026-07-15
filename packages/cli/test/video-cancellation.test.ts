import { expect } from 'chai';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertCliVideoRenderBudget,
  runVideo,
  type VideoRunDependencies,
} from '../src/commands/video.js';

describe('CLI video cancellation', function () {
  this.timeout(30_000);

  let tempRoot = '';

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'docblocks-video-cancel-'));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('passes the caller signal into the linked renderer and preserves its abort reason', async () => {
    const inputPath = join(tempRoot, 'input.md');
    const outputPath = join(tempRoot, 'output.mp4');
    await writeFile(inputPath, '# Input', 'utf8');
    const controller = new AbortController();
    const reason = new Error('cancelled inside video renderer');
    let receivedSignal: AbortSignal | undefined;
    const progress: number[] = [];
    const renderDocToMp4: NonNullable<VideoRunDependencies['renderDocToMp4']> = async (
      _doc,
      _container,
      options,
    ) => {
      receivedSignal = options.signal;
      options.onProgress?.('capturing', 25);
      controller.abort(reason);
      if (options.signal?.aborted) throw options.signal.reason;
      throw new Error('Expected renderer cancellation');
    };

    let caught: unknown;
    try {
      await runVideo(
        inputPath,
        { output: outputPath, signal: controller.signal },
        (_phase, percent) => progress.push(percent),
        { renderDocToMp4 },
      );
    } catch (error: unknown) {
      caught = error;
    }

    expect(receivedSignal).to.equal(controller.signal);
    expect(caught).to.equal(reason);
    expect(progress).to.deep.equal([25]);
  });

  it('reports only bounded monotonic renderer progress', async () => {
    const inputPath = join(tempRoot, 'input.md');
    const outputPath = join(tempRoot, 'output.mp4');
    await writeFile(inputPath, '# Input', 'utf8');
    const progress: number[] = [];
    const renderDocToMp4: NonNullable<VideoRunDependencies['renderDocToMp4']> = async (
      _doc,
      _container,
      options,
    ) => {
      options.onProgress?.('start', -5);
      options.onProgress?.('capture', 40);
      options.onProgress?.('regression', 20);
      options.onProgress?.('encode', 140);
      return { outputPath, duration: 1, frameCount: 2 };
    };

    await runVideo(inputPath, { output: outputPath }, (_phase, percent) => progress.push(percent), {
      renderDocToMp4,
    });

    expect(progress).to.deep.equal([0, 40, 100]);
  });
});

describe('CLI video resource budget', () => {
  it('allows 4K UHD output', () => {
    expect(() => assertCliVideoRenderBudget({ width: 3_840, height: 2_160 })).not.to.throw();
  });

  it('rejects excessive individual dimensions', () => {
    expect(() => assertCliVideoRenderBudget({ width: 7_680, height: 1_080 })).to.throw(
      'dimension limit',
    );
  });

  it('rejects excessive pixels per frame even when each dimension is below the limit', () => {
    expect(() => assertCliVideoRenderBudget({ width: 3_840, height: 3_840 })).to.throw(
      'pixels per frame',
    );
  });

  it('preserves the linked H.264 dimension validation', () => {
    expect(() => assertCliVideoRenderBudget({ width: 1_919, height: 1_080 })).to.throw(
      'even number of pixels',
    );
  });
});
