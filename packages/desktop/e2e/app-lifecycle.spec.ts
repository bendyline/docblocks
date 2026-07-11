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

test('uses the editor toolbar as the custom titlebar', async ({ launchApp }) => {
  const { app, window } = await launchApp();
  const toolbar = window.locator('.squisq-toolbar');
  await expect(toolbar).toBeVisible({ timeout: 30_000 });

  const chrome = await toolbar.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      height: element.getBoundingClientRect().height,
      appRegion:
        style.getPropertyValue('-webkit-app-region') || style.getPropertyValue('app-region'),
    };
  });
  expect(chrome.height).toBe(48);
  expect(chrome.appRegion).toBe('drag');

  // The sidebar titlebar ends with a desktop-only dotted grip so the
  // draggable space beside the workspace gear is visually discoverable.
  const sidebarHeader = window.locator('.db-shell-sidebar-header');
  const grip = await sidebarHeader.evaluate((element) => {
    const headerStyle = getComputedStyle(element);
    const style = getComputedStyle(element, '::after');
    return {
      hasContent: style.content !== 'none' && style.content !== 'normal',
      width: style.width,
      backgroundImage: style.backgroundImage,
      cursor: headerStyle.cursor,
      appRegion:
        style.getPropertyValue('-webkit-app-region') || style.getPropertyValue('app-region'),
    };
  });
  expect(grip.hasContent).toBe(true);
  expect(grip.width).toBe('12px');
  expect(grip.backgroundImage).toContain('radial-gradient');
  expect(grip.cursor).toBe('grab');
  expect(grip.appRegion).toBe('drag');

  // Interactive controls inside the drag region must remain clickable.
  await sidebarHeader.getByRole('button', { name: 'Workspace settings' }).click();
  await expect(window.getByRole('menuitem', { name: /Workspace settings/ })).toBeVisible();
  const sourceTab = toolbar.getByRole('tab', { name: 'Source' });
  await sourceTab.click();
  await expect(sourceTab).toHaveClass(/squisq-toolbar-view-tab--active/);

  // macOS owns its global application menu outside the BrowserWindow;
  // Windows/Linux should have no in-window File/Edit/View menu row.
  if (process.platform !== 'darwin') {
    const browserWindow = await app.browserWindow(window);
    const menuBarVisible = await browserWindow.evaluate((nativeWindow) =>
      nativeWindow.isMenuBarVisible(),
    );
    expect(menuBarVisible).toBe(false);
  }
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

test('workspace dropdown shows the full folder path', async ({ launchApp, workspaceDir }) => {
  const { window } = await launchApp();
  await window.waitForSelector('.db-shell', { timeout: 30_000 });

  await window.locator('.db-workspace-picker-btn').click();
  const activeWorkspace = window.locator('.db-workspace-dropdown-item--active');
  await expect(activeWorkspace.locator('.db-workspace-path')).toHaveText(workspaceDir);
  await expect(activeWorkspace.locator('.db-workspace-path')).toHaveAttribute(
    'title',
    workspaceDir,
  );
});

test('seeds aboutDocBlocks.md on first launch', async ({ launchApp, workspaceDir }) => {
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
  const welcome = path.join(workspaceDir, 'aboutDocBlocks.md');
  expect(fs.existsSync(welcome)).toBe(true);
  expect(fs.readFileSync(welcome, 'utf8')).toContain('Welcome to DocBlocks');
});

test('export dialog exposes a remembered native target control', async ({ launchApp }) => {
  const { window } = await launchApp();
  await window.waitForSelector('.db-shell', { timeout: 30_000 });
  await window.getByRole('button', { name: 'More actions' }).click();
  await window.getByRole('button', { name: 'Export...' }).click();

  const exportTarget = window.getByLabel('Export to');
  await expect(exportTarget).toBeVisible();
  await expect(exportTarget).toHaveValue(/aboutDocBlocks\.pdf$/);
  await expect(window.getByRole('button', { name: 'Choose export location' })).toBeVisible();
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

test('window close waits for the active document session to flush', async ({
  launchApp,
  workspaceDir,
}) => {
  const { app, window } = await launchApp();
  await window.waitForSelector('.db-shell', { timeout: 30_000 });

  const gateway = window.locator('.db-welcome-gateway');
  await expect(gateway).toBeVisible({ timeout: 15_000 });
  await window.locator('.db-welcome-gateway-cta').click();
  const editor = window.locator('[contenteditable="true"]').first();
  await expect(editor).toBeVisible({ timeout: 15_000 });
  const sentinel = `close-flush-${Date.now()}`;
  await editor.click();
  await window.keyboard.press('Control+End');
  await window.keyboard.press('Enter');
  await window.keyboard.insertText(sentinel);
  await expect(editor).toContainText(sentinel);

  await app.close();
  const welcome = path.join(workspaceDir, 'aboutDocBlocks.md');
  expect(fs.readFileSync(welcome, 'utf8')).toContain(sentinel);
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
        docBlocksHost?: {
          fs: {
            readFile(rootPath: string, p: string): Promise<string | null>;
          };
        };
      }
    ).docBlocksHost;
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
