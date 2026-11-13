/**
 * Mocha exit watchdog for CI steps that run without `--exit`.
 *
 * Without `--exit`, Mocha waits for the event loop to drain after the run, so
 * one native handle that outlives its owner (an `fs.watch` left behind by a
 * watcher library, say) holds the step open until the job times out. A macOS
 * run passed all 31 native filesystem tests in 3s and then sat for 90 minutes.
 *
 * Load with `--require`. It tracks open `fs.watch` handles and, if the process
 * is still alive shortly after the run, reports what is keeping it open and
 * exits with the code Mocha already chose. A clean run never sees the timer:
 * it is unref'd, so it cannot keep the process alive itself.
 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const EXIT_GRACE_MS = 10_000;

const openWatchers = new Map<fs.FSWatcher, string>();
const nativeWatch = fs.watch;

function trackedWatch(...args: unknown[]): fs.FSWatcher {
  const watcher = Reflect.apply(nativeWatch, fs, args) as fs.FSWatcher;
  openWatchers.set(watcher, String(args[0]));
  watcher.once('close', () => openWatchers.delete(watcher));
  return watcher;
}

Object.defineProperty(fs, 'watch', { value: trackedWatch, writable: true, configurable: true });
// Rebind ESM named imports (`import { watch } from 'fs'`, as chokidar does).
syncBuiltinESMExports();

export function mochaGlobalTeardown(): void {
  setTimeout(() => {
    const counts = new Map<string, number>();
    for (const name of process.getActiveResourcesInfo()) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const resources = [...counts].map(([name, count]) => `${name} x${count}`).join(', ');
    const summary = `Mocha finished but the process was still alive ${EXIT_GRACE_MS / 1000}s later; forcing exit. Active resources: ${resources}`;
    if (process.env.GITHUB_ACTIONS === 'true') {
      console.error(`::warning title=Mocha did not exit::${summary}`);
    }
    console.error(summary);
    for (const watchedPath of openWatchers.values()) {
      console.error(`  unclosed fs.watch: ${watchedPath}`);
    }
    // No argument: keep the exit code Mocha recorded for the run.
    process.exit();
  }, EXIT_GRACE_MS).unref();
}
