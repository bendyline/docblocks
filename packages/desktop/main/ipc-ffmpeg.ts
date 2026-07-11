/** Bounded FFmpeg detection and owner-scoped video rendering. */

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { HOST_WIRE_LIMITS } from '@bendyline/docblocks/host';

import { parseFfmpegRenderRequest } from './ffmpeg-request.js';
import { registerTrustedIpcHandler } from './ipc-authority.js';
import { bindOwnerGrantRevocation } from './owner-revocation.js';
import { getWorkspaceRoots } from './workspace-roots.js';

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_OUTPUT_LIMIT = 64 * 1024;
const RENDER_TIMEOUT_MS = 10 * 60_000;

let detectedVersion: string | null | undefined;
let detectionPromise: Promise<string | null> | null = null;
let resolvedFfmpegPath: string | null = null;
const activeByOwner = new Map<number, ChildProcess>();
const boundOwners = new WeakSet<Electron.WebContents>();

/** Resolve the ffmpeg binary path: bundled (ffmpeg-static) > system PATH. */
function resolveFfmpegBinary(): string {
  if (resolvedFfmpegPath) return resolvedFfmpegPath;
  try {
    // ffmpeg-static is optional. Guard require so app startup remains safe.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bundled = require('ffmpeg-static');
    if (typeof bundled === 'string' && bundled.length > 0) {
      resolvedFfmpegPath = bundled;
      return bundled;
    }
  } catch {
    // Optional dependency absent; use PATH.
  }
  resolvedFfmpegPath = 'ffmpeg';
  return resolvedFfmpegPath;
}

async function detectFfmpeg(): Promise<string | null> {
  if (detectedVersion !== undefined) return detectedVersion;
  if (detectionPromise) return detectionPromise;

  detectionPromise = new Promise<string | null>((resolve) => {
    try {
      const child = spawn(resolveFfmpegBinary(), ['-version'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      let output = '';
      let settled = false;
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      };
      const timeout = setTimeout(() => {
        child.kill();
        finish(null);
      }, PROBE_TIMEOUT_MS);
      child.stdout.on('data', (chunk: Buffer) => {
        if (output.length >= PROBE_OUTPUT_LIMIT) return;
        output += chunk.toString('utf8').slice(0, PROBE_OUTPUT_LIMIT - output.length);
      });
      child.on('error', () => finish(null));
      child.on('exit', (code) => {
        if (code !== 0 || !output.startsWith('ffmpeg version')) return finish(null);
        finish(output.split('\n')[0]?.trim().slice(0, HOST_WIRE_LIMITS.labelCharacters) ?? null);
      });
    } catch {
      resolve(null);
    }
  }).then((value) => {
    detectedVersion = value;
    detectionPromise = null;
    return value;
  });
  return detectionPromise;
}

function bindRenderOwner(owner: Electron.WebContents): void {
  if (boundOwners.has(owner)) return;
  boundOwners.add(owner);
  const ownerId = owner.id;
  bindOwnerGrantRevocation(owner, () => {
    activeByOwner.get(ownerId)?.kill();
    activeByOwner.delete(ownerId);
  });
}

function runVideoProcess(
  ownerId: number,
  markdownAbsolutePath: string,
  fps?: number,
  quality?: 'draft' | 'normal' | 'high',
): Promise<void> {
  if (activeByOwner.has(ownerId)) {
    throw new Error('A video render is already active for this window');
  }

  return new Promise<void>((resolve, reject) => {
    const args = ['video', markdownAbsolutePath];
    if (fps !== undefined) args.push('--fps', String(fps));
    if (quality !== undefined) args.push('--quality', quality);
    const child = spawn('docblocks', args, {
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    });
    activeByOwner.set(ownerId, child);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (activeByOwner.get(ownerId) === child) activeByOwner.delete(ownerId);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error('Video rendering timed out'));
    }, RENDER_TIMEOUT_MS);
    child.on('error', (error) => finish(error));
    child.on('exit', (code) =>
      finish(code === 0 ? undefined : new Error(`Video renderer exited with code ${code}`)),
    );
  });
}

export function registerFfmpegIpc(): void {
  const sandboxed = process.mas === true;

  registerTrustedIpcHandler('ffmpeg:available', 0, async () => {
    if (sandboxed) return false;
    return (await detectFfmpeg()) !== null;
  });

  registerTrustedIpcHandler('ffmpeg:version', 0, async () => {
    if (sandboxed) return null;
    return detectFfmpeg();
  });

  registerTrustedIpcHandler(
    'ffmpeg:renderVideo',
    3,
    async (event, workspaceValue: unknown, markdownValue: unknown, optionsValue: unknown) => {
      const owner = event.sender;
      bindRenderOwner(owner);
      if (sandboxed) {
        throw new Error('Video rendering is unavailable in the Mac App Store build');
      }
      const request = parseFfmpegRenderRequest(workspaceValue, markdownValue, optionsValue);
      const roots = getWorkspaceRoots();
      const workspace = roots.get(request.workspaceId);
      if (!workspace) throw new Error('Workspace capability is not registered');
      const markdownAbsolutePath = await roots.resolvePhysical(
        workspace.rootPath,
        request.markdownPath,
      );
      const inputStat = await fs.stat(markdownAbsolutePath);
      if (!inputStat.isFile() || inputStat.size > HOST_WIRE_LIMITS.documentCharacters) {
        throw new Error('Video input is missing or exceeds the document limit');
      }
      await roots.resolveMutation(workspace.rootPath, request.outputPath);

      if (!(await detectFfmpeg())) throw new Error('System ffmpeg is not available');
      await runVideoProcess(
        owner.id,
        markdownAbsolutePath,
        request.options.fps,
        request.options.quality,
      );

      const outputAbsolutePath = await roots.resolvePhysical(
        workspace.rootPath,
        request.outputPath,
      );
      const outputStat = await fs.stat(outputAbsolutePath);
      if (!outputStat.isFile()) throw new Error('Video renderer did not produce a regular file');
      if (path.extname(outputAbsolutePath).toLowerCase() !== '.mp4') {
        throw new Error('Video renderer produced an unexpected target');
      }
      return request.outputPath;
    },
  );
}
