import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
// The app's remote Swift package, capacitor-swift-pm, is cloned from GitHub on
// every fresh runner, and that fetch intermittently stalls: SwiftPM times out
// twice at 30 s, then fails with a missing-cache git error before anything
// compiles. Resolve packages as their own retried step, into the same derived
// data the archive uses, so `archive` starts from a complete checkout and
// never fetches. A failure that persists across every attempt still fails.
const attempts = 3;
export function resolveSwiftPackages(project, derivedDataPath) {
  for (let attempt = 1; ; attempt += 1) {
    const result = spawnSync(
      'xcodebuild',
      [
        '-project',
        project,
        '-scheme',
        'App',
        '-derivedDataPath',
        derivedDataPath,
        '-skipPackageUpdates',
        '-resolvePackageDependencies',
      ],
      { stdio: 'inherit' },
    );
    if (result.error) throw result.error;
    if (result.status === 0) return;
    if (attempt === attempts)
      throw new Error(
        `xcodebuild -resolvePackageDependencies failed (${result.status}) after ${attempts} attempts.`,
      );
    // Start the next attempt without this build's partial clones. The shared
    // ~/Library/Caches SwiftPM cache belongs to SwiftPM and is left alone.
    rmSync(path.join(derivedDataPath, 'SourcePackages'), { recursive: true, force: true });
    const seconds = 15 * attempt;
    process.stderr.write(
      `Swift package resolution failed (${result.status}); retrying in ${seconds} s.\n`,
    );
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
  }
}
