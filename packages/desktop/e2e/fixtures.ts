/**
 * Shared Playwright fixture for launching the source Electron app against
 * isolated directories.
 *
 * Playwright's `_electron.launch()` attaches Node's inspector to Electron's
 * main process. Electron 39.2+ can terminate with SIGTRAP / 0x80000003 while
 * activating an inspector that has no DevTools window, which also presents a
 * native Windows crash dialog. Launch the executable normally and attach only
 * to Chromium's renderer CDP endpoint, matching the packaged-app fixture.
 */

import {
  chromium,
  test as base,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const electronPath = require('electron') as unknown as string;
const LAUNCH_TIMEOUT_MS = 30_000;
const GRACEFUL_CLOSE_TIMEOUT_MS = 20_000;
const FORCED_CLOSE_TIMEOUT_MS = 5_000;
const MAX_PROCESS_LOG_LENGTH = 128 * 1024;
const closingApplications = new WeakMap<ChildProcess, Promise<void>>();

export interface DocBlocksFixtures {
  userDataDir: string;
  workspaceDir: string;
  launchApp: (extraArgs?: string[]) => Promise<LaunchedDocBlocksApplication>;
}

export interface LaunchedDocBlocksApplication {
  window: Page;
  close(): Promise<void>;
}

interface RunningApplication extends LaunchedDocBlocksApplication {
  browser: Browser;
  context: BrowserContext;
  process: ChildProcess;
  processLog(): string;
}

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeTmpDir(directory: string): void {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    // Best effort on Windows, where Chromium can briefly retain file locks.
  }
}

function cleanEnv(workspaceDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  delete env.NODE_OPTIONS;
  env.NODE_ENV = 'production';
  env.DOCBLOCKS_DISABLE_HARDWARE_ACCELERATION = '1';
  env.DOCBLOCKS_E2E_DEFAULT_ROOT = workspaceDir;
  return env;
}

function waitForDevTools(child: ChildProcess, readLog: () => string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const inspectLog = (): void => {
      const match = /DevTools listening on (ws:\/\/[^\s]+)/u.exec(readLog());
      if (match?.[1]) finish(() => resolve(match[1]));
    };
    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new Error(`Timed out waiting for the source renderer DevTools endpoint.\n${readLog()}`),
        ),
      );
    }, LAUNCH_TIMEOUT_MS);

    child.stdout?.on('data', inspectLog);
    child.stderr?.on('data', inspectLog);
    child.once('error', (error) => finish(() => reject(error)));
    child.once('exit', (code, signal) => {
      finish(() =>
        reject(
          new Error(
            `Source Electron exited before renderer connection (code=${String(code)}, ` +
              `signal=${String(signal)}).\n${readLog()}`,
          ),
        ),
      );
    });
  });
}

async function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
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

async function forceCloseProcess(child: ChildProcess): Promise<void> {
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
  await waitForProcessExit(child, FORCED_CLOSE_TIMEOUT_MS);
}

function closeApplication(application: RunningApplication): Promise<void> {
  const existing = closingApplications.get(application.process);
  if (existing) return existing;

  const closing = closeApplicationOnce(application).finally(() =>
    closingApplications.delete(application.process),
  );
  closingApplications.set(application.process, closing);
  return closing;
}

async function closeApplicationOnce(application: RunningApplication): Promise<void> {
  if (application.process.exitCode === null && application.process.signalCode === null) {
    try {
      await application.window.evaluate(() => {
        const host = (
          globalThis as {
            docBlocksHost?: { lifecycle?: { requestWindowClose(): void } };
          }
        ).docBlocksHost;
        host?.lifecycle?.requestWindowClose();
      });
    } catch {
      // The assertion path may already have closed or crashed the renderer.
    }
    if (!(await waitForProcessExit(application.process, GRACEFUL_CLOSE_TIMEOUT_MS))) {
      await forceCloseProcess(application.process);
    }
  }
  try {
    await application.browser.close();
  } catch {
    // Closing the final Electron window also closes the CDP transport.
  }
  await waitForProcessExit(application.process, FORCED_CLOSE_TIMEOUT_MS);
}

async function launchSourceApplication(
  appRoot: string,
  userDataDir: string,
  workspaceDir: string,
  extraArgs: string[],
): Promise<RunningApplication> {
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--noerrdialogs',
    '--disable-breakpad',
    '--disable-gpu',
    // The automation process already owns an isolated user-data/workspace
    // boundary. OS-managed runners can deny Chromium's nested sandbox child
    // launch (renderer reason=launch-failed), so do not nest another sandbox.
    '--no-sandbox',
    appRoot,
    ...extraArgs,
  ];

  const child = spawn(electronPath, args, {
    cwd: appRoot,
    env: cleanEnv(workspaceDir),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let log = '';
  const appendLog = (chunk: Buffer | string): void => {
    log = `${log}${chunk.toString()}`.slice(-MAX_PROCESS_LOG_LENGTH);
  };
  child.stdout?.on('data', appendLog);
  child.stderr?.on('data', appendLog);
  const processLog = (): string => log;

  let browser: Browser | undefined;
  try {
    const endpoint = await waitForDevTools(child, processLog);
    browser = await chromium.connectOverCDP(endpoint, { timeout: LAUNCH_TIMEOUT_MS });
    const context = browser.contexts()[0];
    if (!context) throw new Error('Source Electron exposed no browser context.');
    const window = context.pages()[0] ?? (await context.waitForEvent('page'));
    await window.waitForURL('app://docblocks/**', {
      waitUntil: 'domcontentloaded',
      timeout: LAUNCH_TIMEOUT_MS,
    });
    await window.waitForFunction(
      () => {
        const host = (globalThis as { docBlocksHost?: unknown }).docBlocksHost;
        return typeof host === 'object' && host !== null;
      },
      undefined,
      { timeout: 5_000 },
    );

    const application: RunningApplication = {
      browser,
      context,
      process: child,
      window,
      processLog,
      close: async () => closeApplication(application),
    };
    return application;
  } catch (error: unknown) {
    try {
      await browser?.close();
    } catch {
      // Preserve the launch failure.
    }
    await forceCloseProcess(child);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail}\nSource Electron process output:\n${processLog()}`);
  }
}

export const test = base.extend<DocBlocksFixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixture signature
  userDataDir: async ({}, use) => {
    const directory = makeTmpDir('docblocks-e2e-userdata-');
    await use(directory);
    removeTmpDir(directory);
  },

  // eslint-disable-next-line no-empty-pattern -- Playwright fixture signature
  workspaceDir: async ({}, use) => {
    const directory = makeTmpDir('docblocks-e2e-workspace-');
    await use(directory);
    removeTmpDir(directory);
  },

  launchApp: async ({ userDataDir, workspaceDir }, use, testInfo) => {
    const appRoot = path.resolve(__dirname, '..');
    let running: RunningApplication | undefined;

    await use(async (extraArgs: string[] = []) => {
      if (running && running.process.exitCode === null && running.process.signalCode === null) {
        throw new Error('The source fixture supports one active application at a time.');
      }
      running = await launchSourceApplication(appRoot, userDataDir, workspaceDir, extraArgs);
      const current = running;
      return {
        window: current.window,
        close: async () => {
          await current.close();
          if (running === current) running = undefined;
        },
      };
    });

    if (running && testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('source-electron-process.log', {
        body: running.processLog(),
        contentType: 'text/plain',
      });
    }
    await running?.close();
  },
});

export { expect } from '@playwright/test';
