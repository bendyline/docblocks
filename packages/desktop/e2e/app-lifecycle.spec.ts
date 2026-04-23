/**
 * End-to-end smoke + key-flow tests for the DocBlocks Electron app.
 *
 * These tests launch the built app (dist/main/main.cjs) via Playwright's
 * _electron.launch() and drive the first-launch bootstrap, menu
 * commands, and the IPC path-traversal guard.
 *
 * Runtime expectations: the test runner must have already produced a
 * fresh `npm run build` beforehand (the playwright config assumes the
 * caller handles that — see package.json test:e2e script).
 */

import { test, expect } from './fixtures.js';
import fs from 'node:fs';
import path from 'node:path';

test('boots and renders the shell', async ({ launchApp }) => {
  const { window } = await launchApp();
  await window.waitForSelector('.db-shell', { timeout: 30_000 });
  await expect(window.locator('.db-shell')).toBeVisible();
});

test('default workspace folder exists on disk after first launch', async ({
  launchApp,
  workspaceDir,
}) => {
  const { window } = await launchApp();
  await window.waitForSelector('.db-shell', { timeout: 30_000 });
  // Main process creates the folder synchronously during getDefault().
  expect(fs.existsSync(workspaceDir)).toBe(true);
  expect(fs.statSync(workspaceDir).isDirectory()).toBe(true);
});

test('seeds aboutDocblocks.md on first launch', async ({ launchApp, workspaceDir }) => {
  const { window } = await launchApp();
  await window.waitForSelector('.db-shell', { timeout: 30_000 });
  // The shell seeds the welcome doc asynchronously; give it a moment to
  // write + open before probing disk.
  await window.waitForFunction(
    () => {
      const root = document.querySelector('.db-shell');
      return !!root && root.textContent?.includes('Welcome to DocBlocks');
    },
    undefined,
    { timeout: 15_000 },
  );
  const welcome = path.join(workspaceDir, 'aboutDocblocks.md');
  expect(fs.existsSync(welcome)).toBe(true);
  expect(fs.readFileSync(welcome, 'utf8')).toContain('Welcome to DocBlocks');
});

test('content persists across relaunch', async ({ launchApp, workspaceDir }) => {
  // First launch: write a file directly (avoids brittle UI typing).
  const first = await launchApp();
  await first.window.waitForSelector('.db-shell', { timeout: 30_000 });
  const target = path.join(workspaceDir, 'e2e-test.md');
  fs.writeFileSync(target, '# Hello from e2e\nsome body text\n', 'utf8');
  await first.app.close();

  // Second launch: the file should still be there and the shell should
  // render against the same workspace.
  const second = await launchApp();
  await second.window.waitForSelector('.db-shell', { timeout: 30_000 });
  expect(fs.existsSync(target)).toBe(true);
  expect(fs.readFileSync(target, 'utf8')).toContain('Hello from e2e');
});

test('renderer cannot read files outside the workspace root', async ({
  launchApp,
  workspaceDir,
}) => {
  const { window } = await launchApp();
  await window.waitForSelector('.db-shell', { timeout: 30_000 });

  // Drive the path-traversal probe through the exposed host API so we
  // actually exercise the IPC boundary (not just the in-process guard).
  const result = await window.evaluate(async (root: string) => {
    const host = (
      window as unknown as {
        docblocksHost?: {
          fs: {
            readFile(rootPath: string, p: string): Promise<string | null>;
          };
        };
      }
    ).docblocksHost;
    if (!host) return { ok: false, reason: 'no-host' };
    try {
      await host.fs.readFile(root, '/../../etc/passwd');
      return { ok: false, reason: 'did-not-throw' };
    } catch (err: unknown) {
      return { ok: true, message: (err as Error).message };
    }
  }, workspaceDir);

  expect(result.ok, `path-traversal probe: ${JSON.stringify(result)}`).toBe(true);
});
