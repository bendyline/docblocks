/**
 * video command
 *
 * Renders a squisq document to MP4 video using Playwright + FFmpeg.
 * Wraps the squisq-cli's renderDocToMp4 programmatic API.
 */

import { lstat, mkdir } from 'node:fs/promises';
import { dirname, basename, extname, resolve } from 'node:path';
import { Command } from 'commander';
import {
  resolveDimensions,
  validateVideoExportOptions,
  type VideoQuality,
  type VideoOrientation,
} from '@bendyline/squisq-video';

const VALID_QUALITIES = ['draft', 'normal', 'high'] as const;
const VALID_ORIENTATIONS = ['landscape', 'portrait'] as const;
const VALID_CAPTIONS = ['off', 'standard', 'social'] as const;

/** Resource ceiling for direct CLI renders. 3840x2160 (4K UHD) remains supported. */
export const CLI_VIDEO_RENDER_LIMITS = Object.freeze({
  maximumDimension: 3_840,
  maximumPixelsPerFrame: 8_294_400,
});

type CaptionOption = (typeof VALID_CAPTIONS)[number];

export interface VideoOptions {
  output?: string;
  fps?: number;
  quality?: VideoQuality;
  orientation?: VideoOrientation;
  captions?: CaptionOption;
  width?: number;
  height?: number;
  /**
   * Replace an existing MP4. Off by default: the render is refused before any
   * reading, browser capture, or FFmpeg encoding when the target exists.
   */
  allowOverwrite?: boolean;
  /** Cancel input preparation, browser capture, or FFmpeg encoding. */
  signal?: AbortSignal;
}

export interface VideoResult {
  outputPath: string;
  duration: number;
  frameCount: number;
}

type RenderDocToMp4 = typeof import('@bendyline/squisq-cli/api').renderDocToMp4;

export interface VideoRunDependencies {
  /** Test/programmatic override; production uses the linked Squisq renderer. */
  renderDocToMp4?: RenderDocToMp4;
}

/**
 * Core video rendering logic — reusable by both CLI and MCP tools.
 */
export async function runVideo(
  inputPath: string,
  opts: VideoOptions,
  onProgress?: (phase: string, percent: number) => void,
  dependencies: VideoRunDependencies = {},
): Promise<VideoResult> {
  throwIfAborted(opts.signal);
  const resolvedInput = resolve(inputPath);

  const fps = opts.fps ?? 30;
  if (!Number.isFinite(fps) || fps < 1 || fps > 120) {
    throw new Error('FPS must be a number between 1 and 120');
  }

  const quality = opts.quality ?? 'normal';
  if (!VALID_QUALITIES.includes(quality as (typeof VALID_QUALITIES)[number])) {
    throw new Error(`Invalid quality "${quality}". Valid: ${VALID_QUALITIES.join(', ')}`);
  }

  const orientation = opts.orientation ?? 'landscape';
  if (!VALID_ORIENTATIONS.includes(orientation as (typeof VALID_ORIENTATIONS)[number])) {
    throw new Error(
      `Invalid orientation "${orientation}". Valid: ${VALID_ORIENTATIONS.join(', ')}`,
    );
  }

  const captions = opts.captions ?? 'off';
  if (!VALID_CAPTIONS.includes(captions as (typeof VALID_CAPTIONS)[number])) {
    throw new Error(`Invalid captions "${captions}". Valid: ${VALID_CAPTIONS.join(', ')}`);
  }
  const captionStyle = captions === 'off' ? undefined : (captions as 'standard' | 'social');

  assertCliVideoRenderBudget({
    fps,
    quality,
    orientation,
    width: opts.width,
    height: opts.height,
  });

  // Determine output path
  const inputBasename = basename(resolvedInput);
  const inputExt = extname(inputBasename);
  const baseName = inputExt ? inputBasename.slice(0, -inputExt.length) : inputBasename;
  const outputPath = opts.output
    ? resolve(opts.output)
    : resolve(dirname(resolvedInput), `${baseName}.mp4`);

  // Refuse before reading, capturing, or encoding. The linked renderer and
  // FFmpeg own the write itself, so this check is the only point at which an
  // existing MP4 can be protected.
  if (opts.allowOverwrite !== true && (await lstat(outputPath).catch(() => null))) {
    throw new Error(
      [
        'Refusing to overwrite an existing file:',
        `  ${outputPath}`,
        'Pass --allow-overwrite to replace it, or use --output to write elsewhere.',
      ].join('\n'),
    );
  }
  throwIfAborted(opts.signal);

  await mkdir(dirname(outputPath), { recursive: true });
  throwIfAborted(opts.signal);

  console.error(`Reading: ${resolvedInput}`);
  const squisq = await import('@bendyline/squisq-cli/api');
  throwIfAborted(opts.signal);
  const renderDocToMp4 = dependencies.renderDocToMp4 ?? squisq.renderDocToMp4;
  const { readInput } = squisq;
  const result = await readInput(resolvedInput, { signal: opts.signal });
  throwIfAborted(opts.signal);
  const { container, doc } = result;
  console.error(`Using normalized ${result.sourceFormat} document`);

  console.error(
    `Rendering: ${fps} fps, quality: ${quality}, orientation: ${orientation}, captions: ${captions}`,
  );

  let latestProgress = 0;
  const renderResult = await renderDocToMp4(doc, container, {
    signal: opts.signal,
    outputPath,
    fps,
    quality,
    orientation,
    width: opts.width,
    height: opts.height,
    captionStyle,
    onProgress: (phase, percent) => {
      throwIfAborted(opts.signal);
      const boundedPercent = Math.max(0, Math.min(100, percent));
      if (boundedPercent < latestProgress) return;
      latestProgress = boundedPercent;
      if (onProgress) onProgress(phase, boundedPercent);
      else process.stderr.write(`\r  ${phase}: ${boundedPercent}%  `);
      throwIfAborted(opts.signal);
    },
  });
  throwIfAborted(opts.signal);

  process.stderr.write('\r' + ' '.repeat(60) + '\r');
  console.error(`  ✓ ${outputPath}`);
  console.error(
    `  Duration: ${renderResult.duration.toFixed(1)}s, ${renderResult.frameCount} frames`,
  );
  console.error('Done.');

  return {
    outputPath: renderResult.outputPath,
    duration: renderResult.duration,
    frameCount: renderResult.frameCount,
  };
}

/** Reject unsafe dimensions before reading input or launching Playwright/FFmpeg. */
export function assertCliVideoRenderBudget(
  options: Pick<VideoOptions, 'fps' | 'quality' | 'orientation' | 'width' | 'height'>,
): void {
  validateVideoExportOptions(options);
  const { width, height } = resolveDimensions(options);
  for (const [label, value] of [
    ['width', width],
    ['height', height],
  ] as const) {
    if (value % 2 !== 0) {
      throw new RangeError(
        `Video ${label} must be an even number of pixels (got ${value}); H.264 yuv420p cannot encode odd dimensions.`,
      );
    }
  }
  const pixelsPerFrame = width * height;
  const violations: string[] = [];
  if (
    width > CLI_VIDEO_RENDER_LIMITS.maximumDimension ||
    height > CLI_VIDEO_RENDER_LIMITS.maximumDimension
  ) {
    violations.push(
      `${width}x${height} exceeds the ${CLI_VIDEO_RENDER_LIMITS.maximumDimension}-pixel dimension limit`,
    );
  }
  if (pixelsPerFrame > CLI_VIDEO_RENDER_LIMITS.maximumPixelsPerFrame) {
    violations.push(
      `${pixelsPerFrame} pixels per frame exceeds the ${CLI_VIDEO_RENDER_LIMITS.maximumPixelsPerFrame}-pixel limit`,
    );
  }
  if (violations.length > 0) {
    throw new RangeError(`Video render exceeds the CLI resource budget: ${violations.join('; ')}.`);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error('Video rendering was cancelled');
  error.name = 'AbortError';
  throw error;
}

interface VideoCommandOptions {
  output?: string;
  fps?: string;
  quality?: string;
  orientation?: string;
  captions?: string;
  width?: string;
  height?: string;
  allowOverwrite?: boolean;
}

export const videoCommand = new Command('video')
  .description('Render a squisq document to MP4 video')
  .argument('<input>', 'Path to a supported document, .zip/.dbk container, or folder')
  .argument('[output]', 'Output MP4 path (default: <input>.mp4)')
  .option('-o, --output <path>', 'Output MP4 path (default: <input>.mp4)')
  .option('--fps <number>', 'Frames per second', '30')
  .option('--quality <level>', `Encoding quality: ${VALID_QUALITIES.join(', ')}`, 'normal')
  .option(
    '--orientation <orient>',
    `Video orientation: ${VALID_ORIENTATIONS.join(', ')}`,
    'landscape',
  )
  .option('--captions <style>', `Caption style: ${VALID_CAPTIONS.join(', ')}`, 'off')
  .option('--width <pixels>', 'Override video width')
  .option('--height <pixels>', 'Override video height')
  .option('--allow-overwrite', 'replace an existing output MP4 instead of refusing the run')
  .action(async (inputPath: string, outputArg: string | undefined, opts: VideoCommandOptions) => {
    try {
      if (outputArg && !opts.output) {
        opts.output = outputArg;
      }
      await runVideo(inputPath, {
        output: opts.output,
        fps: parseNumberOption('--fps', opts.fps ?? '30'),
        quality: opts.quality as VideoQuality,
        orientation: opts.orientation as VideoOrientation,
        captions: opts.captions as CaptionOption,
        width: opts.width ? parseNumberOption('--width', opts.width) : undefined,
        height: opts.height ? parseNumberOption('--height', opts.height) : undefined,
        allowOverwrite: opts.allowOverwrite,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      process.exitCode = 1;
    }
  });

function parseNumberOption(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number`);
  return parsed;
}
