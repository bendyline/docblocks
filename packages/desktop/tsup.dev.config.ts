import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { defineConfig } from 'tsup';
import treeKill from 'tree-kill';
import { desktopTsupOptions } from './tsup.config';

const RESTART_DEBOUNCE_MS = 50;
const completedInitialBuilds = new Set<'main' | 'preload'>();
let activeLauncher: ChildProcess | undefined;
let restartRequest = 0;

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

async function restartElectron(): Promise<undefined | (() => Promise<void>)> {
  const request = ++restartRequest;
  await new Promise((resolve) => setTimeout(resolve, RESTART_DEBOUNCE_MS));
  if (request !== restartRequest) return undefined;

  const previousLauncher = activeLauncher;
  activeLauncher = undefined;
  if (previousLauncher) await stopProcessTree(previousLauncher);

  const launcher = spawn(process.execPath, [path.resolve('scripts/run-electron.cjs')], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    windowsHide: false,
  });
  activeLauncher = launcher;
  launcher.once('close', () => {
    if (activeLauncher === launcher) activeLauncher = undefined;
  });
  launcher.once('error', (error) => {
    process.stderr.write(`Failed to start the Electron launcher: ${error.message}\n`);
  });

  return async () => {
    if (activeLauncher !== launcher) return;
    activeLauncher = undefined;
    await stopProcessTree(launcher);
  };
}

function onBuildSuccess(target: 'main' | 'preload') {
  return async (): Promise<undefined | (() => Promise<void>)> => {
    completedInitialBuilds.add(target);
    if (completedInitialBuilds.size < 2) return undefined;
    return restartElectron();
  };
}

export default defineConfig([
  {
    ...desktopTsupOptions[0],
    clean: false,
    onSuccess: onBuildSuccess('main'),
  },
  {
    ...desktopTsupOptions[1],
    clean: false,
    onSuccess: onBuildSuccess('preload'),
  },
]);
