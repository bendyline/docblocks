import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

interface PackageJson {
  name?: unknown;
  version?: unknown;
  dependencies?: unknown;
}

const require = createRequire(import.meta.url);
const runtimeVersionCache = new Map<string, string>();

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

/** Declared version plus a hash of the exact linked/installed runtime files being executed. */
export function getDependencyRuntimeVersion(
  packageName: string,
  resolutionSpecifier = packageName,
): string {
  const key = `${packageName}\0${resolutionSpecifier}`;
  const cached = runtimeVersionCache.get(key);
  if (cached) return cached;
  const declared = getDependencyVersion(packageName);
  try {
    const entry = require.resolve(resolutionSpecifier);
    const root = findPackageRoot(entry, packageName);
    const files = collectRuntimeFiles(path.join(root, 'dist'));
    const hash = createHash('sha256');
    for (const file of files) {
      const relative = path.relative(root, file).split(path.sep).join('/');
      hash.update(relative);
      hash.update('\0');
      hash.update(readFileSync(file));
      hash.update('\0');
    }
    const version = `${declared}+runtime.${hash.digest('hex').slice(0, 16)}`;
    runtimeVersionCache.set(key, version);
    return version;
  } catch {
    const version = `${declared}+runtime.unavailable`;
    runtimeVersionCache.set(key, version);
    return version;
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

function findPackageRoot(entry: string, packageName: string): string {
  let directory = path.dirname(entry);
  for (let depth = 0; depth < 12; depth += 1) {
    try {
      const parsed = JSON.parse(
        readFileSync(path.join(directory, 'package.json'), 'utf8'),
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

function collectRuntimeFiles(directory: string): string[] {
  const files: string[] = [];
  const pending = [directory];
  let totalBytes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (entry.isFile() && /\.(?:js|json|css|wasm)$/iu.test(entry.name)) {
        files.push(candidate);
        totalBytes += statSync(candidate).size;
        if (files.length > 4_096 || totalBytes > 512 * 1024 * 1024) {
          throw new Error('Runtime fingerprint input exceeds its safety budget');
        }
      }
    }
  }
  if (files.length === 0) throw new Error('Runtime package has no fingerprintable files');
  return files.sort((left, right) => left.localeCompare(right));
}
