/**
 * Shared Playwright fixture for launching the DocBlocks Electron app
 * against isolated directories.
 *
 * Every test gets:
 *   • a throwaway `userDataDir` so saved settings never pollute dev state
 *   • an explicit `workspaceDir` the first-launch bootstrap is told to
 *     use (avoids DocBlocks inside the real OS Documents folder)
 *   • an env with ELECTRON_RUN_AS_NODE / ELECTRON_NO_ATTACH_CONSOLE
 *     stripped (matches scripts/run-electron.cjs)
 *   • NODE_ENV=production so the main process boots through the app://
 *     protocol loader and skips dev-server handshake
 *
 * `launchApp` returns the running ElectronApplication and its main
 * window; tests dispose of the app via afterEach.
 */

import {
  test as base,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GRACEFUL_CLOSE_TIMEOUT_MS = 20_000;
const FORCED_CLOSE_TIMEOUT_MS = 5_000;
const closingApplications = new WeakMap<ElectronApplication, Promise<void>>();

export interface DocBlocksFixtures {
  userDataDir: string;
  workspaceDir: string;
  launchApp: (extraArgs?: string[]) => Promise<LaunchedDocBlocksApplication>;
}

export interface LaunchedDocBlocksApplication {
  app: ElectronApplication;
  window: Page;
  close(): Promise<void>;
}

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanEnv(workspaceDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  env.NODE_ENV = 'production';
  env.DOCBLOCKS_DISABLE_HARDWARE_ACCELERATION = '1';
  // Tell the main process to use this workspace root instead of
  // OS Documents/DocBlocks. Read by ipc-workspaces.getDefault() when set.
  env.DOCBLOCKS_E2E_DEFAULT_ROOT = workspaceDir;
  return env;
}

async function waitForProcessExit(app: ElectronApplication, timeoutMs: number): Promise<boolean> {
  const child = app.process();
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

async function forceCloseApplication(app: ElectronApplication): Promise<void> {
  const child = app.process();
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32' && child.pid !== undefined) {
      await new Promise<void>((resolve) => {
        execFile(
          'taskkill.exe',
          ['/pid', String(child.pid), '/T', '/F'],
          { windowsHide: true },
          () => resolve(),
        );
      });
    } else {
      child.kill('SIGKILL');
    }
  }
  await waitForProcessExit(app, FORCED_CLOSE_TIMEOUT_MS);
}

function closeApplication(app: ElectronApplication): Promise<void> {
  const existing = closingApplications.get(app);
  if (existing) return existing;

  const closing = closeApplicationOnce(app).finally(() => closingApplications.delete(app));
  closingApplications.set(app, closing);
  return closing;
}

async function closeApplicationOnce(app: ElectronApplication): Promise<void> {
  if (app.process().exitCode !== null || app.process().signalCode !== null) return;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const closeResult = await Promise.race([
    app.close().then(
      () => 'closed' as const,
      () => 'failed' as const,
    ),
    new Promise<'timed-out'>((resolve) => {
      timer = setTimeout(() => resolve('timed-out'), GRACEFUL_CLOSE_TIMEOUT_MS);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });

  if (closeResult !== 'closed') await forceCloseApplication(app);
}

export const test = base.extend<DocBlocksFixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixture signature
  userDataDir: async ({}, use) => {
    const dir = makeTmpDir('docblocks-e2e-userdata-');
    await use(dir);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort on Windows where files may still be locked
    }
  },

  // eslint-disable-next-line no-empty-pattern -- Playwright fixture signature
  workspaceDir: async ({}, use) => {
    const dir = makeTmpDir('docblocks-e2e-workspace-');
    await use(dir);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  },

  launchApp: async ({ userDataDir, workspaceDir }, use) => {
    const appRoot = path.resolve(__dirname, '..');
    let running: ElectronApplication | undefined;

    async function launch(extraArgs: string[] = []): Promise<LaunchedDocBlocksApplication> {
      const args = [
        `--user-data-dir=${userDataDir}`,
        // Native crash dialogs block Playwright teardown and multiply across
        // retries. Keep these Chromium switches before the application path;
        // arguments after it belong to the DocBlocks application instead.
        '--noerrdialogs',
        '--disable-breakpad',
        '--disable-gpu',
        appRoot,
        ...extraArgs,
      ];
      // GitHub Actions Linux runners don't own chrome-sandbox with the
      // setuid bit, so Electron's SUID sandbox aborts at launch. Disable
      // sandboxing in CI — safe because the runner is an isolated VM.
      if (process.platform === 'linux' && process.env.CI) {
        args.push('--no-sandbox');
      }
      const app = await electron.launch({
        args,
        env: cleanEnv(workspaceDir),
        // Longer timeout to cope with cold launches on GitHub Actions runners.
        timeout: 30_000,
      });
      running = app;
      app.once('close', () => {
        if (running === app) running = undefined;
      });
      let window: Page;
      try {
        window = await app.firstWindow();
      } catch (error: unknown) {
        // macOS normally keeps an application alive with no windows. A failed
        // Playwright launch must not inherit that behavior or strand the worker.
        running = undefined;
        await forceCloseApplication(app);
        const detail = error instanceof Error ? `: ${error.message}` : '';
        throw new Error(`Electron did not expose its main window${detail}`);
      }
      try {
        await window.waitForLoadState('domcontentloaded');
      } catch (error: unknown) {
        running = undefined;
        await forceCloseApplication(app);
        const detail = error instanceof Error ? `: ${error.message}` : '';
        throw new Error(`Electron renderer failed during launch${detail}`);
      }
      try {
        await window.waitForFunction(
          () => {
            const host = (globalThis as { docBlocksHost?: unknown }).docBlocksHost;
            return typeof host === 'object' && host !== null;
          },
          undefined,
          { timeout: 5_000 },
        );
      } catch (error: unknown) {
        // A sandbox-incompatible preload import prevents the entire bridge
        // from loading. Fail at launch instead of exercising browser fallbacks
        // and then hanging on the renderer close acknowledgement.
        running = undefined;
        await forceCloseApplication(app);
        const detail = error instanceof Error ? `: ${error.message}` : '';
        throw new Error(`Electron preload did not expose docBlocksHost${detail}`);
      }
      return {
        app,
        window,
        close: () => closeApplication(app),
      };
    }

    await use(launch);

    if (running) {
      await closeApplication(running);
    }
  },
});

export { expect } from '@playwright/test';
