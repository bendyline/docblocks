/** Bounded FFmpeg detection for renderer capability reporting. */

import { spawn } from 'node:child_process';
import { HOST_WIRE_LIMITS } from '@bendyline/docblocks/host';

import { registerTrustedIpcHandler } from './ipc-authority.js';

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_OUTPUT_LIMIT = 64 * 1024;

let detectedVersion: string | null | undefined;
let detectionPromise: Promise<string | null> | null = null;

async function detectFfmpeg(): Promise<string | null> {
  if (detectedVersion !== undefined) return detectedVersion;
  if (detectionPromise) return detectionPromise;

  detectionPromise = new Promise<string | null>((resolve) => {
    try {
      const child = spawn('ffmpeg', ['-version'], {
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
}
