/**
 * Keeps Vite's dependency pre-bundle cache in step with the Squisq link state.
 *
 * Vite decides whether `node_modules/.vite/deps` is still valid from a hash of
 * this repo's lockfile plus the resolved config. `npm run link:squisq`,
 * `npm run unlink:squisq`, and a plain `npm install` / `npm ci` swap the
 * `@bendyline/squisq*` directories between registry copies and symlinks into
 * `..\squisq` without touching either input, so Vite keeps trusting a cache
 * whose recorded source paths no longer exist. The registry install of
 * `@bendyline/squisq-formats` carries its own nested `@xmldom/xmldom` (this
 * repo pins an older one at the root); the linked package resolves it from
 * `..\squisq\node_modules` instead. The next re-optimization then reads the
 * old path, fails with ENOENT, and the renderer never loads.
 *
 * Every Vite config that runs a dev server calls `squisqAwareViteCacheDir`
 * before `defineConfig`. It fingerprints the link state — which Squisq
 * packages are symlinks, where they point, and the sibling checkout's lockfile
 * — stamps the cache directory with that fingerprint, and clears the directory
 * whenever the stamp disagrees. That is exactly `vite --force`, applied only
 * when it is needed.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** File inside the Vite cache directory that records the state it was built under. */
export const SQUISQ_LINK_STATE_STAMP = 'squisq-link-state';

/** Fingerprint used while every Squisq package is a registry copy. */
export const REGISTRY_LINK_STATE = 'registry';

const LOCKFILE_NAMES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
];

export interface SquisqLinkState {
  /** Package names currently symlinked out of `node_modules/@bendyline`. */
  linked: string[];
  /** Stable fingerprint; two states with equal keys can share a dependency cache. */
  key: string;
}

interface LinkedPackageRecord {
  name: string;
  target: string;
  lockfile: string;
}

function squisqPackageDirs(root: string): string[] {
  const scopeDir = path.join(root, 'node_modules', '@bendyline');
  let entries: string[];
  try {
    entries = fs.readdirSync(scopeDir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name === 'squisq' || name.startsWith('squisq-'))
    .sort()
    .map((name) => path.join(scopeDir, name));
}

/**
 * Walks up from a linked package's real location to the nearest lockfile and
 * fingerprints it, so a dependency change inside the sibling checkout also
 * invalidates the cache. Returns '' when no lockfile is found.
 */
function fingerprintNearestLockfile(startDir: string, cache: Map<string, string>): string {
  let dir = startDir;
  for (;;) {
    for (const name of LOCKFILE_NAMES) {
      const candidate = path.join(dir, name);
      const cached = cache.get(candidate);
      if (cached !== undefined) return cached;
      let content: Buffer;
      try {
        content = fs.readFileSync(candidate);
      } catch {
        continue;
      }
      const digest = createHash('sha256').update(content).digest('hex');
      const fingerprint = `${candidate}:${digest}`;
      cache.set(candidate, fingerprint);
      return fingerprint;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return '';
    dir = parent;
  }
}

/** Reads which Squisq packages are linked and derives the cache fingerprint. */
export function readSquisqLinkState(root: string = repoRoot): SquisqLinkState {
  const lockfileCache = new Map<string, string>();
  const records: LinkedPackageRecord[] = [];

  for (const packageDir of squisqPackageDirs(root)) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(packageDir);
    } catch {
      continue;
    }
    if (!stat.isSymbolicLink()) continue;

    const name = `@bendyline/${path.basename(packageDir)}`;
    let target: string;
    try {
      target = fs.realpathSync(packageDir);
    } catch {
      // Dangling link: still distinct from a registry copy, but there is no
      // checkout behind it whose lockfile could be fingerprinted.
      records.push({ name, target: `dangling:${fs.readlinkSync(packageDir)}`, lockfile: '' });
      continue;
    }
    records.push({ name, target, lockfile: fingerprintNearestLockfile(target, lockfileCache) });
  }

  if (records.length === 0) {
    return { linked: [], key: REGISTRY_LINK_STATE };
  }
  const digest = createHash('sha256').update(JSON.stringify(records)).digest('hex').slice(0, 16);
  return { linked: records.map((record) => record.name), key: `linked:${digest}` };
}

export interface DepCacheReconciliation {
  cacheDir: string;
  key: string;
  /** True when an existing cache built under a different (or unknown) state was discarded. */
  cleared: boolean;
}

/**
 * Makes `cacheDir` safe for the given link-state key: keeps it when its stamp
 * already matches, otherwise discards it (a cache with no stamp was built under
 * an unknown state and is discarded too) and writes the new stamp.
 */
export function reconcileViteDepCache(cacheDir: string, key: string): DepCacheReconciliation {
  const stampPath = path.join(cacheDir, SQUISQ_LINK_STATE_STAMP);
  let previous: string | null;
  try {
    previous = fs.readFileSync(stampPath, 'utf8').trim();
  } catch {
    previous = null;
  }
  if (previous === key) {
    return { cacheDir, key, cleared: false };
  }

  const existed = fs.existsSync(cacheDir);
  if (existed) {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(stampPath, `${key}\n`);
  return { cacheDir, key, cleared: existed };
}

/**
 * Call once at the top of a surface's `vite.config.ts` with the config's
 * directory. Reconciles that surface's dependency cache with the current
 * Squisq link state and returns the directory to pin as Vite's `cacheDir`, so
 * the stamp and the cache it describes can never drift apart.
 */
export function squisqAwareViteCacheDir(packageDir: string, root: string = repoRoot): string {
  const cacheDir = path.join(packageDir, 'node_modules', '.vite');
  const state = readSquisqLinkState(root);
  const result = reconcileViteDepCache(cacheDir, state.key);
  if (result.cleared) {
    const description =
      state.linked.length > 0
        ? `linked from the sibling checkout (${state.linked.join(', ')})`
        : 'registry copies';
    console.warn(
      `[docblocks] Squisq packages are now ${description}. ` +
        `Cleared the Vite dependency cache at ${cacheDir}; the next start re-optimizes once.`,
    );
  }
  return cacheDir;
}
