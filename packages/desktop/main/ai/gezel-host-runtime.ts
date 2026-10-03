/**
 * Where DocBlocks finds a Gezel it can run itself.
 *
 * Hosting needs two things the Electron app cannot provide on its own: the
 * Gezel daemon's code (`gezeld`, from `@bendyline/gezel-service`) and a real
 * Node to run it. The app binary cannot stand in for Node — the `runAsNode`
 * fuse is off, and the daemon's native modules expect Node's ABI.
 *
 * - **Packaged builds** look for the runtime DocBlocks ships under
 *   `resources/gezel-host/`: `node/node[.exe]` and the service tree whose
 *   entry is `service/dist/bin/gezeld.js`. A build without it cannot host,
 *   and AI then works only while the person's own Gezel is running.
 * - **Development** (unpackaged) takes the daemon entry from
 *   `DOCBLOCKS_GEZEL_SERVICE_ENTRY` — typically a sibling Gezel checkout's
 *   `packages/service/dist/bin/gezeld.js` — and Node from
 *   `DOCBLOCKS_GEZEL_NODE_PATH`, else the Node a Gezel install keeps in its
 *   home, else `node` on PATH. Packaged builds ignore these variables: an
 *   environment variable must never choose code a shipped app executes.
 *
 * Engines are optional in both. A shipped `gezel-host/native-bin/` (or, in
 * development, `DOCBLOCKS_GEZEL_NATIVE_BIN_DIR`) holds Gezel's native release
 * laid out as `<platform>-<backend>/gezel-llama-server[.exe]` and becomes the
 * daemon's `nativeBinDir`, so a first run downloads nothing. Without it the
 * daemon downloads the engine it pins on first use, with visible progress.
 * It must be the release the bundled service pins — the service publishes
 * that pin as `@bendyline/gezel-service/native-release`.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface GezelHostRuntime {
  readonly nodePath: string;
  readonly daemonEntry: string;
  /** Pre-staged native engines, so the daemon need not download them. */
  readonly nativeBinDir?: string;
  /** The daemon's version, for display. */
  readonly version: string | null;
  readonly source: 'bundled' | 'development';
}

export interface HostRuntimeEnvironment {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  readonly exists: (candidate: string) => boolean;
  readonly readText: (file: string) => Promise<string>;
}

export function defaultHostRuntimeEnvironment(
  isPackaged: boolean,
  resourcesPath: string,
): HostRuntimeEnvironment {
  return {
    isPackaged,
    resourcesPath,
    env: process.env,
    platform: process.platform,
    homedir: os.homedir(),
    exists: existsSync,
    readText: (file) => readFile(file, 'utf8'),
  };
}

function nodeBinaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'node.exe' : 'node';
}

/** `<service root>/package.json` sits two directories above `dist/bin/gezeld.js`. */
async function serviceVersion(
  daemonEntry: string,
  runtime: HostRuntimeEnvironment,
): Promise<string | null> {
  try {
    const manifest = JSON.parse(
      await runtime.readText(path.join(path.dirname(daemonEntry), '..', '..', 'package.json')),
    ) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

function findOnPath(runtime: HostRuntimeEnvironment): string | null {
  const name = nodeBinaryName(runtime.platform);
  const separator = runtime.platform === 'win32' ? ';' : ':';
  for (const directory of (runtime.env.PATH ?? runtime.env.Path ?? '').split(separator)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    if (runtime.exists(candidate)) return candidate;
  }
  return null;
}

function developmentNode(runtime: HostRuntimeEnvironment): string | null {
  const configured = runtime.env.DOCBLOCKS_GEZEL_NODE_PATH?.trim();
  if (configured && path.isAbsolute(configured) && runtime.exists(configured)) return configured;
  const gezelHome = runtime.env.GEZEL_HOME?.trim() || path.join(runtime.homedir, '.gezel');
  const managed = path.join(gezelHome, 'bin', nodeBinaryName(runtime.platform));
  if (runtime.exists(managed)) return managed;
  return findOnPath(runtime);
}

export async function resolveGezelHostRuntime(
  runtime: HostRuntimeEnvironment,
): Promise<GezelHostRuntime | null> {
  if (runtime.isPackaged) {
    const root = path.join(runtime.resourcesPath, 'gezel-host');
    const nodePath = path.join(root, 'node', nodeBinaryName(runtime.platform));
    const daemonEntry = path.join(root, 'service', 'dist', 'bin', 'gezeld.js');
    if (!runtime.exists(nodePath) || !runtime.exists(daemonEntry)) return null;
    const nativeBinDir = path.join(root, 'native-bin');
    return {
      nodePath,
      daemonEntry,
      ...(runtime.exists(nativeBinDir) ? { nativeBinDir } : {}),
      version: await serviceVersion(daemonEntry, runtime),
      source: 'bundled',
    };
  }

  const daemonEntry = runtime.env.DOCBLOCKS_GEZEL_SERVICE_ENTRY?.trim();
  if (!daemonEntry || !path.isAbsolute(daemonEntry) || !runtime.exists(daemonEntry)) return null;
  const nodePath = developmentNode(runtime);
  if (!nodePath) return null;
  const nativeBinDir = runtime.env.DOCBLOCKS_GEZEL_NATIVE_BIN_DIR?.trim();
  return {
    nodePath,
    daemonEntry,
    ...(nativeBinDir && path.isAbsolute(nativeBinDir) && runtime.exists(nativeBinDir)
      ? { nativeBinDir }
      : {}),
    version: await serviceVersion(daemonEntry, runtime),
    source: 'development',
  };
}
