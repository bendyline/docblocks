import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { getDependencyRuntimeVersion, getDependencyVersion } from '../src/version.js';

const PACKAGE = '@bendyline/squisq-formats';

describe('linked runtime fingerprint', function () {
  this.timeout(30_000);

  it('does not block the event loop while walking and hashing the runtime', async () => {
    // The cache is process-wide, so a sibling test that already fingerprinted
    // this package would make the timing meaningless. Load a fresh module
    // instance to guarantee this call performs the real walk.
    const fresh = (await import(
      `../src/version.js?fingerprint-isolation=${Date.now()}`
    )) as typeof import('../src/version.js');

    // Immediates only run when control returns to the event loop. A
    // synchronous walk would return its value without a single turn elapsing.
    let turns = 0;
    let running = true;
    const tick = (): void => {
      if (!running) return;
      turns += 1;
      setImmediate(tick);
    };
    setImmediate(tick);

    const version = await fresh.getDependencyRuntimeVersion(PACKAGE);
    running = false;

    expect(version).to.match(/\+runtime\.[0-9a-f]{16}$/u);
    expect(turns, 'the event loop must keep turning during fingerprinting').to.be.greaterThan(0);
  });

  it('derives the exact contract value the artifact identity depends on', async () => {
    // The version keys the conversion cache and identifies artifacts, so the
    // async walk must hash the same files, in the same order, the same way.
    expect(await getDependencyRuntimeVersion(PACKAGE)).to.equal(expectedRuntimeVersion(PACKAGE));
  });

  it('caches the value and shares one walk between concurrent first callers', async () => {
    const fresh = (await import(
      `../src/version.js?fingerprint-cache=${Date.now()}`
    )) as typeof import('../src/version.js');

    const [first, second] = await Promise.all([
      fresh.getDependencyRuntimeVersion(PACKAGE),
      fresh.getDependencyRuntimeVersion(PACKAGE),
    ]);
    expect(first).to.equal(second);

    const started = process.hrtime.bigint();
    const cached = await fresh.getDependencyRuntimeVersion(PACKAGE);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    expect(cached).to.equal(first);
    expect(elapsedMs, 'a cached read must not re-walk the runtime').to.be.lessThan(50);
  });

  it('reports an unavailable runtime instead of throwing', async () => {
    expect(await getDependencyRuntimeVersion('@bendyline/not-a-real-package')).to.equal(
      'unknown+runtime.unavailable',
    );
  });
});

/** Independent reimplementation of the fingerprint the CLI must keep emitting. */
function expectedRuntimeVersion(packageName: string): string {
  const require = createRequire(import.meta.url);
  const declared = getDependencyVersion(packageName);
  const root = findRoot(require.resolve(packageName), packageName);
  const files = collect(path.join(root, 'dist')).sort((left, right) => left.localeCompare(right));
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(root, file).split(path.sep).join('/'));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return `${declared}+runtime.${hash.digest('hex').slice(0, 16)}`;
}

function findRoot(entry: string, packageName: string): string {
  let directory = path.dirname(entry);
  for (let depth = 0; depth < 12; depth += 1) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8')) as {
        name?: unknown;
      };
      if (parsed.name === packageName) return directory;
    } catch {
      // Keep walking toward the package root.
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`Cannot locate ${packageName}`);
}

function collect(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collect(candidate));
    else if (entry.isFile() && /\.(?:js|json|css|wasm)$/iu.test(entry.name)) {
      statSync(candidate);
      files.push(candidate);
    }
  }
  return files;
}
