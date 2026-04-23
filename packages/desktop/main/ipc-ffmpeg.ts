/**
 * IPC handlers for ffmpeg detection + video rendering.
 *
 * Detection: probe `ffmpeg -version` on PATH at startup, cache the result.
 *
 * Rendering: defers to whatever external ffmpeg is available. High-quality
 * video rendering via the squisq-video pipeline is delegated to the CLI
 * (which bundles its own Playwright setup); an MVP implementation just
 * shells out to a user's system ffmpeg with a minimal markdown→MP4 path
 * if available, otherwise throws so the in-browser export path is used.
 */

import { ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { getWorkspaceRoots } from './workspace-roots.js';

let detectedVersion: string | null | undefined;
let resolvedFfmpegPath: string | null = null;

/** Resolve the ffmpeg binary path: bundled (ffmpeg-static) > system PATH. */
function resolveFfmpegBinary(): string {
  if (resolvedFfmpegPath) return resolvedFfmpegPath;
  try {
    // ffmpeg-static is an optional dep. Guard require so the app starts
    // even if it's missing.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bundled = require('ffmpeg-static');
    if (typeof bundled === 'string' && bundled.length > 0) {
      resolvedFfmpegPath = bundled;
      return bundled;
    }
  } catch {
    // optional dep absent — fall through
  }
  resolvedFfmpegPath = 'ffmpeg';
  return resolvedFfmpegPath;
}

async function detectFfmpeg(): Promise<string | null> {
  if (detectedVersion !== undefined) return detectedVersion;
  const bin = resolveFfmpegBinary();
  detectedVersion = await new Promise<string | null>((resolve) => {
    try {
      const child = spawn(bin, ['-version'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
      });
      child.on('error', () => resolve(null));
      child.on('exit', (code) => {
        if (code === 0 && out.startsWith('ffmpeg version')) {
          const firstLine = out.split('\n')[0]?.trim();
          resolve(firstLine ?? 'ffmpeg');
        } else {
          resolve(null);
        }
      });
    } catch {
      resolve(null);
    }
  });
  return detectedVersion;
}

export function registerFfmpegIpc(): void {
  ipcMain.handle('ffmpeg:available', async () => {
    return (await detectFfmpeg()) !== null;
  });

  ipcMain.handle('ffmpeg:version', async () => {
    return detectFfmpeg();
  });

  /**
   * Render a markdown file at an absolute path to MP4. The renderer must
   * supply an absolute path inside a registered workspace root.
   *
   * MVP: invoke the docblocks CLI if available on PATH. Falls back to
   * throwing so the caller can keep using the in-browser exporter.
   */
  ipcMain.handle(
    'ffmpeg:renderVideo',
    async (
      _e,
      markdownAbsolutePath: string,
      options: { fps?: number; quality?: 'draft' | 'normal' | 'high' },
    ) => {
      const roots = getWorkspaceRoots();
      // Validate the path is inside a registered workspace root.
      const known = roots.list().some((r) => {
        const rel = path.relative(r.rootPath, markdownAbsolutePath);
        return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
      });
      if (!known) throw new Error('Path is outside any registered workspace root');

      try {
        await fs.access(markdownAbsolutePath);
      } catch {
        throw new Error(`File not found: ${markdownAbsolutePath}`);
      }

      const available = await detectFfmpeg();
      if (!available) throw new Error('System ffmpeg is not available');

      // Delegate to `docblocks video` CLI which itself uses ffmpeg+Playwright.
      return await new Promise<string>((resolve, reject) => {
        const args = ['video', markdownAbsolutePath];
        if (options.fps) args.push('--fps', String(options.fps));
        if (options.quality) args.push('--quality', options.quality);
        const child = spawn('docblocks', args, { stdio: ['ignore', 'inherit', 'inherit'] });
        child.on('error', reject);
        child.on('exit', (code) => {
          if (code === 0) {
            const out = markdownAbsolutePath.replace(/\.md$/i, '.mp4');
            resolve(out);
          } else {
            reject(new Error(`docblocks video exited with code ${code}`));
          }
        });
      });
    },
  );
}
