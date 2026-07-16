import { expect } from 'chai';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertCliVideoRenderBudget,
  runVideo,
  selectVideoOutput,
  type VideoRunDependencies,
} from '../src/commands/video.js';

describe('CLI video output selection', () => {
  it('accepts the destination from either the positional argument or --output', () => {
    expect(selectVideoOutput('positional.mp4', undefined)).to.equal('positional.mp4');
    expect(selectVideoOutput(undefined, 'option.mp4')).to.equal('option.mp4');
    expect(selectVideoOutput(undefined, undefined)).to.equal(undefined);
  });

  it('refuses two ways of naming one destination rather than silently losing one', () => {
    // `-o` used to win silently, writing a file the caller never named.
    expect(() => selectVideoOutput('positional.mp4', 'option.mp4')).to.throw(
      'Two output paths were requested',
    );
    expect(() => selectVideoOutput('positional.mp4', 'option.mp4')).to.throw('positional.mp4');
    expect(() => selectVideoOutput('positional.mp4', 'option.mp4')).to.throw('option.mp4');
  });

  it('refuses a redundant repeat too, so the contract has no ambiguous corner', () => {
    expect(() => selectVideoOutput('same.mp4', 'same.mp4')).to.throw(
      'Two output paths were requested',
    );
  });
});

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

describe('CLI video output safety', function () {
  this.timeout(30_000);

  let tempRoot = '';

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'docblocks-video-overwrite-'));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('refuses to overwrite an existing MP4 before rendering it', async () => {
    const inputPath = join(tempRoot, 'input.md');
    const outputPath = join(tempRoot, 'input.mp4');
    await writeFile(inputPath, '# Input', 'utf8');
    await writeFile(outputPath, 'hand-authored video', 'utf8');
    let rendered = false;
    const renderDocToMp4: NonNullable<VideoRunDependencies['renderDocToMp4']> = async () => {
      rendered = true;
      return { outputPath, duration: 1, frameCount: 2 };
    };

    let caught: unknown;
    try {
      await runVideo(inputPath, {}, undefined, { renderDocToMp4 });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(Error);
    const message = (caught as Error).message;
    expect(message).to.include('Refusing to overwrite');
    expect(message).to.include(outputPath);
    expect(message).to.include('--allow-overwrite');
    // The refusal must precede the expensive capture/encode work entirely.
    expect(rendered).to.equal(false);
    expect(await readFile(outputPath, 'utf8')).to.equal('hand-authored video');
  });

  it('renders over an existing MP4 when overwrite is allowed', async () => {
    const inputPath = join(tempRoot, 'input.md');
    const outputPath = join(tempRoot, 'input.mp4');
    await writeFile(inputPath, '# Input', 'utf8');
    await writeFile(outputPath, 'hand-authored video', 'utf8');
    let rendered = false;
    const renderDocToMp4: NonNullable<VideoRunDependencies['renderDocToMp4']> = async () => {
      rendered = true;
      return { outputPath, duration: 1, frameCount: 2 };
    };

    const result = await runVideo(inputPath, { allowOverwrite: true }, undefined, {
      renderDocToMp4,
    });

    expect(rendered).to.equal(true);
    expect(result.outputPath).to.equal(outputPath);
  });

  it('renders normally when the default output does not exist', async () => {
    const inputPath = join(tempRoot, 'input.md');
    const outputPath = join(tempRoot, 'input.mp4');
    await writeFile(inputPath, '# Input', 'utf8');
    let receivedOutputPath: string | undefined;
    const renderDocToMp4: NonNullable<VideoRunDependencies['renderDocToMp4']> = async (
      _doc,
      _container,
      options,
    ) => {
      receivedOutputPath = options.outputPath;
      return { outputPath, duration: 1, frameCount: 2 };
    };

    const result = await runVideo(inputPath, {}, undefined, { renderDocToMp4 });

    expect(receivedOutputPath).to.equal(outputPath);
    expect(result.frameCount).to.equal(2);
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
