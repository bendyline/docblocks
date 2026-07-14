import { HOST_WIRE_LIMITS, isBoundedString } from '@bendyline/docblocks/host';
import { parseWorkspacePath, type WorkspacePath } from '@bendyline/docblocks/filesystem';

export interface FfmpegRenderOptions {
  fps?: number;
  quality?: 'draft' | 'normal' | 'high';
}

export interface FfmpegRenderRequest {
  workspaceId: string;
  markdownPath: WorkspacePath;
  outputPath: WorkspacePath;
  options: FfmpegRenderOptions;
}

export function parseFfmpegRenderRequest(
  workspaceValue: unknown,
  markdownValue: unknown,
  optionsValue: unknown,
): FfmpegRenderRequest {
  if (!isBoundedString(workspaceValue, HOST_WIRE_LIMITS.identifierCharacters, 1)) {
    throw new Error('Invalid video workspace capability');
  }
  if (!isBoundedString(markdownValue, HOST_WIRE_LIMITS.pathCharacters, 1)) {
    throw new Error('Invalid video document path');
  }
  const markdownPath = parseWorkspacePath(markdownValue);
  if (!markdownPath || !markdownPath.toLowerCase().endsWith('.md')) {
    throw new Error('Video input must be a workspace-relative Markdown file');
  }

  if (typeof optionsValue !== 'object' || optionsValue === null || Array.isArray(optionsValue)) {
    throw new Error('Invalid video rendering options');
  }
  const record = optionsValue as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'fps' && key !== 'quality')) {
    throw new Error('Unknown video rendering option');
  }

  const options: FfmpegRenderOptions = {};
  if (record.fps !== undefined) {
    if (
      !Number.isInteger(record.fps) ||
      (record.fps as number) < 1 ||
      (record.fps as number) > 120
    ) {
      throw new Error('Video FPS must be an integer from 1 to 120');
    }
    options.fps = record.fps as number;
  }
  if (record.quality !== undefined) {
    if (record.quality !== 'draft' && record.quality !== 'normal' && record.quality !== 'high') {
      throw new Error('Invalid video quality');
    }
    options.quality = record.quality;
  }

  const outputPath = parseWorkspacePath(markdownPath.replace(/\.md$/i, '.mp4'));
  return { workspaceId: workspaceValue, markdownPath, outputPath, options };
}
