import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AiImageAccess } from '@bendyline/docblocks/host';

/**
 * Gezel's image engine draws through Vulkan on Windows x64, and the Vulkan
 * loader (`vulkan-1.dll`) ships with graphics drivers, not with Windows or
 * DocBlocks. Without it the engine cannot even start, so say so up front
 * instead of failing the first render.
 */
export function imageGraphicsDriverBlock(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = existsSync,
): Extract<AiImageAccess, { kind: 'unavailable' }> | null {
  if (platform !== 'win32' || arch !== 'x64') return null;
  const windows = env.SystemRoot ?? env.windir ?? 'C:\\Windows';
  if (exists(path.join(windows, 'System32', 'vulkan-1.dll'))) return null;
  return {
    kind: 'unavailable',
    reason: 'graphics-driver',
    message:
      'Image generation needs a graphics driver with Vulkan support. Update your graphics driver, then restart DocBlocks.',
  };
}
