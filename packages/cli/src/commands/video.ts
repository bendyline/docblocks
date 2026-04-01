/**
 * video command
 *
 * Renders a squisq document to MP4 video using Playwright + FFmpeg.
 * Wraps the squisq-cli's renderDocToMp4 programmatic API.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, basename, extname, resolve } from 'node:path';
import { Command } from 'commander';
import type { VideoQuality, VideoOrientation } from '@bendyline/squisq-video';

const VALID_QUALITIES = ['draft', 'normal', 'high'] as const;
const VALID_ORIENTATIONS = ['landscape', 'portrait'] as const;
const VALID_CAPTIONS = ['off', 'standard', 'social'] as const;

type CaptionOption = (typeof VALID_CAPTIONS)[number];

export interface VideoOptions {
  output?: string;
  fps?: number;
  quality?: VideoQuality;
  orientation?: VideoOrientation;
  captions?: CaptionOption;
  width?: number;
  height?: number;
}

export interface VideoResult {
  outputPath: string;
  duration: number;
  frameCount: number;
}

/**
 * Core video rendering logic — reusable by both CLI and MCP tools.
 */
export async function runVideo(
  inputPath: string,
  opts: VideoOptions,
  onProgress?: (phase: string, percent: number) => void,
): Promise<VideoResult> {
  const resolvedInput = resolve(inputPath);

  const fps = opts.fps ?? 30;
  if (fps < 1 || fps > 120) {
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

  // Determine output path
  const inputBasename = basename(resolvedInput);
  const inputExt = extname(inputBasename);
  const baseName = inputExt ? inputBasename.slice(0, -inputExt.length) : inputBasename;
  const outputPath = opts.output
    ? resolve(opts.output)
    : resolve(dirname(resolvedInput), `${baseName}.mp4`);

  await mkdir(dirname(outputPath), { recursive: true });

  console.error(`Reading: ${resolvedInput}`);
  const { readInput, renderDocToMp4 } = await import('@bendyline/squisq-cli/api');
  const result = await readInput(resolvedInput);
  const { container } = result;

  // Get or parse Doc
  let doc;
  if (result.doc) {
    console.error('Using pre-built Doc JSON');
    doc = result.doc;
  } else if (result.markdownDoc) {
    const { markdownToDoc } = await import('@bendyline/squisq/doc');
    doc = markdownToDoc(result.markdownDoc);
  } else {
    throw new Error('No document found in input');
  }

  console.error(
    `Rendering: ${fps} fps, quality: ${quality}, orientation: ${orientation}, captions: ${captions}`,
  );

  const renderResult = await renderDocToMp4(doc, container, {
    outputPath,
    fps,
    quality,
    orientation,
    width: opts.width,
    height: opts.height,
    captionStyle,
    onProgress:
      onProgress ??
      ((phase, percent) => {
        process.stderr.write(`\r  ${phase}: ${percent}%  `);
      }),
  });

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

interface VideoCommandOptions {
  output?: string;
  fps?: string;
  quality?: string;
  orientation?: string;
  captions?: string;
  width?: string;
  height?: string;
}

export const videoCommand = new Command('video')
  .description('Render a squisq document to MP4 video')
  .argument('<input>', 'Path to .md file, .zip/.dbk container, or folder')
  .argument('[output]', 'Output MP4 path (default: <input>.mp4)')
  .option('-o, --output <path>', 'Output MP4 path (default: <input>.mp4)')
  .option('--fps <number>', 'Frames per second (default: 30)', '30')
  .option(
    '--quality <level>',
    `Encoding quality: ${VALID_QUALITIES.join(', ')} (default: normal)`,
    'normal',
  )
  .option(
    '--orientation <orient>',
    `Video orientation: ${VALID_ORIENTATIONS.join(', ')} (default: landscape)`,
    'landscape',
  )
  .option('--captions <style>', `Caption style: ${VALID_CAPTIONS.join(', ')} (default: off)`, 'off')
  .option('--width <pixels>', 'Override video width')
  .option('--height <pixels>', 'Override video height')
  .action(async (inputPath: string, outputArg: string | undefined, opts: VideoCommandOptions) => {
    try {
      if (outputArg && !opts.output) {
        opts.output = outputArg;
      }
      await runVideo(inputPath, {
        output: opts.output,
        fps: parseInt(opts.fps ?? '30', 10),
        quality: opts.quality as VideoQuality,
        orientation: opts.orientation as VideoOrientation,
        captions: opts.captions as CaptionOption,
        width: opts.width ? parseInt(opts.width, 10) : undefined,
        height: opts.height ? parseInt(opts.height, 10) : undefined,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      process.exitCode = 1;
    }
  });
