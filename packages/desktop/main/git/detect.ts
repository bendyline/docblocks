/**
 * Binary detection for git and the GitHub CLI (gh).
 *
 * GUI apps on macOS inherit launchd's minimal PATH, so Homebrew installs are
 * probed at their well-known locations before falling back to plain PATH
 * lookup. Results are cached for the process lifetime; store-sandboxed
 * builds (Mac App Store) report everything unavailable because the App
 * Sandbox forbids spawning external binaries — same policy as ffmpeg.
 */

import { spawn } from 'node:child_process';

export interface DetectedTool {
  /** Binary path or name suitable for spawn(). */
  path: string;
  /** Human version string, e.g. "2.44.0" for git. */
  version: string;
}

/** Minimum git version — we rely on `git restore` / `git switch` (2.23, 2019). */
const MIN_GIT_MAJOR = 2;
const MIN_GIT_MINOR = 23;

let cachedGit: DetectedTool | null | undefined;
let cachedGh: DetectedTool | null | undefined;

/** True when git features must be dark (Mac App Store sandbox). */
export function gitFeaturesDisabled(): boolean {
  return (process as NodeJS.Process & { mas?: boolean }).mas === true;
}

function candidatesFor(tool: 'git' | 'gh'): string[] {
  if (process.platform === 'darwin') {
    return [tool, `/opt/homebrew/bin/${tool}`, `/usr/local/bin/${tool}`, `/usr/bin/${tool}`];
  }
  if (process.platform === 'win32') {
    return tool === 'git'
      ? ['git', 'C:\\Program Files\\Git\\cmd\\git.exe']
      : ['gh', 'C:\\Program Files\\GitHub CLI\\gh.exe'];
  }
  return [tool];
}

function probeVersion(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const child = spawn(bin, ['--version'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
      });
      child.on('error', () => resolve(null));
      child.on('close', (code) => {
        resolve(code === 0 ? (out.split('\n')[0]?.trim() ?? null) : null);
      });
    } catch {
      resolve(null);
    }
  });
}

async function probeCandidates(
  tool: 'git' | 'gh',
  accept: (firstLine: string) => string | null,
): Promise<DetectedTool | null> {
  for (const candidate of candidatesFor(tool)) {
    const firstLine = await probeVersion(candidate);
    if (firstLine === null) continue;
    const version = accept(firstLine);
    if (version !== null) return { path: candidate, version };
  }
  return null;
}

/** "git version 2.44.0" (or "...windows.1") → "2.44.0…", null if too old. */
function acceptGitVersion(firstLine: string): string | null {
  const match = /^git version (\d+)\.(\d+)(\S*)/.exec(firstLine);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < MIN_GIT_MAJOR || (major === MIN_GIT_MAJOR && minor < MIN_GIT_MINOR)) {
    return null;
  }
  return `${match[1]}.${match[2]}${match[3] ?? ''}`;
}

/** "gh version 2.63.2 (2026-01-15)" → "2.63.2". */
function acceptGhVersion(firstLine: string): string | null {
  const match = /^gh version (\S+)/.exec(firstLine);
  return match ? match[1] : null;
}

export async function detectGit(): Promise<DetectedTool | null> {
  if (gitFeaturesDisabled()) return null;
  if (cachedGit !== undefined) return cachedGit;
  cachedGit = await probeCandidates('git', acceptGitVersion);
  return cachedGit;
}

export async function detectGh(): Promise<DetectedTool | null> {
  if (gitFeaturesDisabled()) return null;
  if (cachedGh !== undefined) return cachedGh;
  cachedGh = await probeCandidates('gh', acceptGhVersion);
  return cachedGh;
}

/** For tests only — clear the probe caches. */
export function resetDetectionForTests(): void {
  cachedGit = undefined;
  cachedGh = undefined;
}
