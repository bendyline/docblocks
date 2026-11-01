import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:os';
import path from 'node:path';
import { defineConfig } from 'tsup';
import treeKill from 'tree-kill';
import { desktopTsupOptions } from './tsup.config';
import { createDevBuildPolicy } from './scripts/dev-build-policy';

/**
 * Everything the main and preload bundles are built from. tsup's default
 * watches the whole package, which holds a directory handle open in every
 * folder under dist/: Windows cannot rename or delete a folder while one is
 * open inside it, so a dev watcher broke `npm run stage:gezel-native` and
 * electron-builder's staging of the Gezel engines. Setting `watch` here turns
 * watch mode on; a CLI `--watch` would replace this list with the package root.
 */
const watchedSources = [
  'main',
  'preload',
  'shared',
  'intel-mac-final.json',
  'native-platform-policy.json',
  'package.json',
  'tsconfig.json',
  'tsconfig.main.json',
  'tsconfig.preload.json',
];

let activeLauncher: ChildProcess | undefined;

function isAlreadyExitedError(error: Error): boolean {
  const processError = error as Error & { cmd?: string; code?: number | string };
  return (
    processError.code === 'ESRCH' ||
    (process.platform === 'win32' &&
      processError.code === 128 &&
      processError.cmd?.startsWith('taskkill') === true)
  );
}

function stopProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    treeKill(pid, 'SIGTERM', (error) => {
      if (error && !isAlreadyExitedError(error)) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function launchElectron(): void {
  const launcher = spawn(process.execPath, [path.resolve('scripts/run-electron.cjs')], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  activeLauncher = launcher;
  launcher.once('close', () => {
    if (activeLauncher === launcher) activeLauncher = undefined;
  });
  launcher.once('error', (error) => {
    process.stderr.write(`Failed to start the Electron launcher: ${error.message}\n`);
  });
}

const buildCompleted = createDevBuildPolicy(launchElectron, () => {
  process.stderr.write(
    'Desktop main/preload rebuilt. The running app is unchanged. Save recordings and documents, then restart npm run dev:desktop to use this build.\n',
  );
});

// Terminal shutdown is explicit. Never return this as an onSuccess cleanup:
// tsup invokes those cleanups before EVERY rebuild, killing unsaved recordings.
// A signal listener replaces Node's default exit, so exit once the app is
// stopped. Otherwise Ctrl+C on Windows ends npm and cmd around this watcher
// and leaves it running, orphaned, with its file watches still open.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.once(signal, () => {
    const launcher = activeLauncher;
    activeLauncher = undefined;
    void (launcher ? stopProcessTree(launcher) : Promise.resolve())
      .catch((error: unknown) => {
        process.stderr.write(`Failed to stop the Electron launcher: ${String(error)}\n`);
      })
      .finally(() => process.exit(128 + constants.signals[signal]));
  });
}

function onBuildSuccess(target: 'main' | 'preload') {
  return async (): Promise<void> => buildCompleted(target);
}

export default defineConfig([
  {
    ...desktopTsupOptions[0],
    clean: false,
    watch: watchedSources,
    onSuccess: onBuildSuccess('main'),
  },
  {
    ...desktopTsupOptions[1],
    clean: false,
    watch: watchedSources,
    onSuccess: onBuildSuccess('preload'),
  },
]);
