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
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface DetectedTool {
  /** Binary path or name suitable for spawn(). */
  path: string;
  /** Human version string, e.g. "2.44.0" for git. */
  version: string;
}

/** Minimum git version — we rely on `git restore` / `git switch` (2.23, 2019). */
const MIN_GIT_MAJOR = 2;
const MIN_GIT_MINOR = 23;
const VERSION_PROBE_TIMEOUT_MS = 5_000;
const MAX_VERSION_OUTPUT_BYTES = 4 * 1024;
const APPLE_GIT_SHIM = '/usr/bin/git';
const XCODE_SELECT = '/usr/bin/xcode-select';
const DARWIN_GIT_LOCATIONS = ['/opt/homebrew/bin/git', '/usr/local/bin/git'] as const;

let cachedGit: DetectedTool | null | undefined;
let cachedGh: DetectedTool | null | undefined;

/** True when git features must be dark (Mac App Store sandbox). */
export function gitFeaturesDisabled(): boolean {
  return (process as NodeJS.Process & { mas?: boolean }).mas === true;
}

function candidatesFor(tool: 'git' | 'gh'): string[] {
  if (process.platform === 'darwin') {
    // Git has a dedicated path-only discovery flow below; never let this
    // generic version probe reach Apple's `/usr/bin/git` installer shim.
    if (tool === 'git') return [];
    return [tool, `/opt/homebrew/bin/${tool}`, `/usr/local/bin/${tool}`, `/usr/bin/${tool}`];
  }
  if (process.platform === 'win32') {
    return tool === 'git'
      ? ['git', 'C:\\Program Files\\Git\\cmd\\git.exe']
      : ['gh', 'C:\\Program Files\\GitHub CLI\\gh.exe'];
  }
  return [tool];
}

function probeFirstLine(bin: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    try {
      const child = spawn(bin, args, {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      let out = '';
      let outputBytes = 0;
      const terminate = (): void => {
        child.kill();
        const forceKill = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 1_000);
        forceKill.unref();
      };
      child.stdout.on('data', (chunk: Buffer) => {
        if (settled) return;
        outputBytes += chunk.byteLength;
        if (outputBytes > MAX_VERSION_OUTPUT_BYTES) {
          terminate();
          finish(null);
          return;
        }
        out += chunk.toString('utf8');
      });
      child.on('error', () => finish(null));
      child.on('close', (code) => {
        finish(code === 0 ? (out.split('\n')[0]?.trim() ?? null) : null);
      });
      timer = setTimeout(() => {
        terminate();
        finish(null);
      }, VERSION_PROBE_TIMEOUT_MS);
      timer.unref();
    } catch {
      finish(null);
    }
  });
}

function probeVersion(bin: string): Promise<string | null> {
  return probeFirstLine(bin, ['--version']);
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

export interface DarwinGitDetectionDependencies {
  readonly pathEnvironment: string | undefined;
  resolveExecutable(candidate: string): Promise<string | null>;
  probeFirstLine(bin: string, args: readonly string[]): Promise<string | null>;
}

async function resolveExecutable(candidate: string): Promise<string | null> {
  try {
    await fs.access(candidate, fsConstants.X_OK);
    return await fs.realpath(candidate);
  } catch {
    return null;
  }
}

function darwinPathCandidates(pathEnvironment: string | undefined): string[] {
  if (!pathEnvironment) return [];
  return pathEnvironment
    .split(':')
    .filter((entry) => path.posix.isAbsolute(entry))
    .map((entry) => path.posix.join(entry, 'git'));
}

/**
 * Detect Git on macOS without ever executing `/usr/bin/git`.
 *
 * Apple's system binary is a shim that opens the Command Line Tools installer
 * on a clean Mac. Third-party binaries are resolved to an executable realpath
 * before probing. Apple's Git is reached only through the active developer
 * directory reported by the non-interactive `xcode-select --print-path` check.
 */
export async function detectDarwinGit(
  dependencies: DarwinGitDetectionDependencies = {
    pathEnvironment: process.env.PATH,
    resolveExecutable,
    probeFirstLine,
  },
): Promise<DetectedTool | null> {
  const seen = new Set<string>();

  const probeCandidate = async (candidate: string): Promise<DetectedTool | null> => {
    const resolved = await dependencies.resolveExecutable(candidate);
    if (resolved === null || resolved === APPLE_GIT_SHIM || seen.has(resolved)) return null;
    seen.add(resolved);
    const firstLine = await dependencies.probeFirstLine(resolved, ['--version']);
    if (firstLine === null) return null;
    const version = acceptGitVersion(firstLine);
    return version === null ? null : { path: resolved, version };
  };

  for (const candidate of [
    ...DARWIN_GIT_LOCATIONS,
    ...darwinPathCandidates(dependencies.pathEnvironment),
  ]) {
    const detected = await probeCandidate(candidate);
    if (detected !== null) return detected;
  }

  const developerDirectory = await dependencies.probeFirstLine(XCODE_SELECT, ['--print-path']);
  if (developerDirectory === null || !path.posix.isAbsolute(developerDirectory)) return null;
  return probeCandidate(path.posix.join(developerDirectory, 'usr/bin/git'));
}

export async function detectGit(): Promise<DetectedTool | null> {
  if (gitFeaturesDisabled()) return null;
  if (cachedGit !== undefined) return cachedGit;
  cachedGit =
    process.platform === 'darwin'
      ? await detectDarwinGit()
      : await probeCandidates('git', acceptGitVersion);
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
