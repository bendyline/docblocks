import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

interface PackageJson {
  name?: unknown;
  version?: unknown;
  dependencies?: unknown;
}

const require = createRequire(import.meta.url);
const runtimeVersionCache = new Map<string, string>();
const runtimeVersionInFlight = new Map<string, Promise<string>>();

export function getPackageVersion(): string {
  const pkg = readPackageJson();
  if (typeof pkg?.version === 'string' && pkg.version.length > 0) {
    return pkg.version;
  }

  return '0.0.0';
}

/** Version declared for a shipped runtime engine such as linked Squisq. */
export function getDependencyVersion(packageName: string): string {
  const dependencies = readPackageJson()?.dependencies;
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    return 'unknown';
  }
  const version = (dependencies as Record<string, unknown>)[packageName];
  return typeof version === 'string' && version.length > 0 ? version : 'unknown';
}

/**
 * Declared version plus a hash of the exact linked/installed runtime files
 * being executed.
 *
 * Fingerprinting walks and hashes the whole runtime `dist/`, which is far too
 * much work to do synchronously: this runs on the first `convert_document` of
 * a live stdio MCP server, where a blocked event loop stalls progress
 * notifications, cancellations, and all other protocol traffic. Every read is
 * therefore asynchronous, and the loop is free between files.
 *
 * The value is a contract — it identifies artifacts and keys the conversion
 * cache — so the hashed input, order, and budgets are unchanged. Results are
 * cached per package, and concurrent first calls share one walk.
 */
export function getDependencyRuntimeVersion(
  packageName: string,
  resolutionSpecifier = packageName,
): Promise<string> {
  const key = `${packageName}\0${resolutionSpecifier}`;
  const cached = runtimeVersionCache.get(key);
  if (cached) return Promise.resolve(cached);
  const inFlight = runtimeVersionInFlight.get(key);
  if (inFlight) return inFlight;

  const pending = computeRuntimeVersion(packageName, resolutionSpecifier)
    .then((version) => {
      runtimeVersionCache.set(key, version);
      return version;
    })
    .finally(() => {
      runtimeVersionInFlight.delete(key);
    });
  runtimeVersionInFlight.set(key, pending);
  return pending;
}

async function computeRuntimeVersion(
  packageName: string,
  resolutionSpecifier: string,
): Promise<string> {
  const declared = getDependencyVersion(packageName);
  try {
    const entry = require.resolve(resolutionSpecifier);
    const root = await findPackageRoot(entry, packageName);
    const files = await collectRuntimeFiles(path.join(root, 'dist'));
    const hash = createHash('sha256');
    for (const file of files) {
      const relative = path.relative(root, file).split(path.sep).join('/');
      hash.update(relative);
      hash.update('\0');
      hash.update(await readFile(file));
      hash.update('\0');
    }
    return `${declared}+runtime.${hash.digest('hex').slice(0, 16)}`;
  } catch {
    return `${declared}+runtime.unavailable`;
  }
}

function readPackageJson(): PackageJson | null {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf-8');
    return JSON.parse(raw) as PackageJson;
  } catch {
    // Fall through to a conservative fallback for unusual bundled layouts.
    return null;
  }
}

async function findPackageRoot(entry: string, packageName: string): Promise<string> {
  let directory = path.dirname(entry);
  for (let depth = 0; depth < 12; depth += 1) {
    try {
      const parsed = JSON.parse(
        await readFile(path.join(directory, 'package.json'), 'utf8'),
      ) as PackageJson;
      if (parsed.name === packageName) return directory;
    } catch {
      // Keep walking toward the package root.
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Cannot locate runtime package root for ${packageName}`);
}

async function collectRuntimeFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [directory];
  let totalBytes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (entry.isFile() && /\.(?:js|json|css|wasm)$/iu.test(entry.name)) {
        files.push(candidate);
        totalBytes += (await stat(candidate)).size;
        if (files.length > 4_096 || totalBytes > 512 * 1024 * 1024) {
          throw new Error('Runtime fingerprint input exceeds its safety budget');
        }
      }
    }
  }
  if (files.length === 0) throw new Error('Runtime package has no fingerprintable files');
  return files.sort((left, right) => left.localeCompare(right));
}
