/**
 * Shared Playwright fixture for launching the DocBlocks Electron app
 * against isolated directories.
 *
 * Every test gets:
 *   • a throwaway `userDataDir` so saved settings never pollute dev state
 *   • an explicit `workspaceDir` the first-launch bootstrap is told to
 *     use (avoids real ~/Documents/DocBlocks)
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

export interface DocblocksFixtures {
  userDataDir: string;
  workspaceDir: string;
  launchApp: () => Promise<{ app: ElectronApplication; window: Page }>;
}

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanEnv(workspaceDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  env.NODE_ENV = 'production';
  // Tell the main process to use this workspace root instead of
  // ~/Documents/DocBlocks. Read by ipc-workspaces.getDefault() when set.
  env.DOCBLOCKS_E2E_DEFAULT_ROOT = workspaceDir;
  return env;
}

export const test = base.extend<DocblocksFixtures>({
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

    async function launch(): Promise<{ app: ElectronApplication; window: Page }> {
      const app = await electron.launch({
        args: [appRoot, `--user-data-dir=${userDataDir}`],
        env: cleanEnv(workspaceDir),
        // Longer timeout to cope with cold launches on GitHub Actions runners.
        timeout: 30_000,
      });
      running = app;
      const window = await app.firstWindow();
      await window.waitForLoadState('domcontentloaded');
      return { app, window };
    }

    await use(launch);

    if (running) {
      try {
        await running.close();
      } catch {
        // ignore double-close
      }
    }
  },
});

export { expect } from '@playwright/test';
