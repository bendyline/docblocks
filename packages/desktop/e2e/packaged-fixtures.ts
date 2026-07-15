import {
  chromium,
  test as base,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePackagedArtifact, type PackagedArtifact } from './packaged-artifact.js';

const LAUNCH_TIMEOUT_MS = 30_000;
const MAX_PROCESS_LOG_LENGTH = 128 * 1024;

export interface PackagedApplication {
  artifact: PackagedArtifact;
  browser: Browser;
  context: BrowserContext;
  window: Page;
  process: ChildProcess;
  processLog: () => string;
  close: () => Promise<void>;
}

interface PackagedFixtures {
  userDataDir: string;
  workspaceDir: string;
  launchPackagedApp: () => Promise<PackagedApplication>;
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
          new Error(`Timed out waiting for the packaged renderer DevTools endpoint.\n${readLog()}`),
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
            `Packaged DocBlocks exited before renderer connection (code=${String(code)}, ` +
              `signal=${String(signal)}).\n${readLog()}`,
          ),
        ),
      );
    });
  });
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
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

async function launchPackagedApplication(
  artifact: PackagedArtifact,
  userDataDir: string,
  workspaceDir: string,
): Promise<PackagedApplication> {
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--noerrdialogs',
    '--disable-breakpad',
    '--disable-gpu',
    // Packaged smoke runs inside an already isolated automation boundary.
    // Avoid a nested Chromium sandbox launch failure on managed runners.
    '--no-sandbox',
  ];

  const child = spawn(artifact.executablePath, args, {
    cwd: path.dirname(artifact.executablePath),
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
    if (!context) throw new Error('The packaged Electron process exposed no browser context.');
    const window = context.pages()[0] ?? (await context.waitForEvent('page'));
    await window.waitForURL('app://docblocks/**', {
      waitUntil: 'domcontentloaded',
      timeout: LAUNCH_TIMEOUT_MS,
    });

    const close = async (): Promise<void> => {
      try {
        await window.evaluate(() => {
          const host = (
            globalThis as {
              docBlocksHost?: { lifecycle?: { requestWindowClose(): void } };
            }
          ).docBlocksHost;
          host?.lifecycle?.requestWindowClose();
        });
      } catch {
        // The window may already have closed as part of the assertion path.
      }
      if (!(await waitForExit(child, 5_000))) child.kill('SIGKILL');
      try {
        await browser?.close();
      } catch {
        // Closing the final Electron window also closes the CDP transport.
      }
      await waitForExit(child, 5_000);
    };

    return { artifact, browser, context, window, process: child, processLog, close };
  } catch (error) {
    try {
      await browser?.close();
    } catch {
      // Ignore cleanup failure while preserving the launch error.
    }
    child.kill('SIGKILL');
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail}\nPackaged process output:\n${processLog()}`);
  }
}

export const test = base.extend<PackagedFixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixture signature
  userDataDir: async ({}, use) => {
    const directory = makeTmpDir('docblocks-packaged-userdata-');
    await use(directory);
    removeTmpDir(directory);
  },

  // eslint-disable-next-line no-empty-pattern -- Playwright fixture signature
  workspaceDir: async ({}, use) => {
    const directory = makeTmpDir('docblocks-packaged-workspace-');
    await use(directory);
    removeTmpDir(directory);
  },

  launchPackagedApp: async ({ userDataDir, workspaceDir }, use, testInfo) => {
    let running: PackagedApplication | undefined;
    await use(async () => {
      if (running)
        throw new Error('The packaged fixture supports one active application per test.');
      running = await launchPackagedApplication(
        resolvePackagedArtifact(),
        userDataDir,
        workspaceDir,
      );
      return running;
    });

    if (running && testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('packaged-process.log', {
        body: running.processLog(),
        contentType: 'text/plain',
      });
    }
    await running?.close();
  },
});

export { expect } from '@playwright/test';
