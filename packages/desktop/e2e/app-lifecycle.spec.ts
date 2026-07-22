/**
 * End-to-end smoke + key-flow tests for the DocBlocks Electron app.
 *
 * These tests launch the built app (dist/main/main.cjs), attach to its
 * renderer over CDP, and drive the first-launch bootstrap, menu commands,
 * and the IPC path-traversal guard.
 *
 * Runtime expectations: the test runner must have already produced a
 * fresh `npm run build` beforehand (the playwright config assumes the
 * caller handles that — see package.json test:e2e script).
 */

import { test, expect } from './fixtures.js';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MemoryContentContainer } from '@bendyline/squisq/storage';
import { containerToZip, zipToContainer } from '@bendyline/squisq-formats/container';
import { deriveWorkspaceId } from '../main/workspace-id.js';

test('boots and renders the shell', async ({ launchApp }) => {
  const { window } = await launchApp();
  await window.waitForSelector('.db-shell', { timeout: 30_000 });
  await expect(window.locator('.db-shell')).toBeVisible();
  await expect(window).toHaveTitle('aboutDocBlocks - DocBlocks');
});

test('cross-origin isolates the renderer and offers Animated GIF export', async ({ launchApp }) => {
  const { window } = await launchApp();
  await window.waitForSelector('.db-shell', { timeout: 30_000 });

  const runtime = await window.evaluate(() => ({
    crossOriginIsolated: globalThis.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
  }));
  expect(runtime).toEqual({ crossOriginIsolated: true, sharedArrayBuffer: true });

  await window.getByRole('button', { name: 'Export and share' }).click();
  await window.getByRole('menuitem', { name: 'Export animated gif...' }).click();
  const dialog = window.getByRole('dialog', { name: 'Export Animated GIF' });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByLabel('Format')).toHaveValue('gif');
});

test('uses the editor toolbar as the custom titlebar', async ({ launchApp }) => {
  const { window } = await launchApp();
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
  expect(chrome.height).toBe(42);
  expect(chrome.appRegion).toBe('drag');

  // The shared shell lifts the tabs within its roomier 48px browser toolbar.
  // Desktop must win that equal-specificity rule so labels stay centered in
  // the compact 42px titlebar instead of riding against its top edge.
  const writeTab = toolbar.getByRole('tab', { name: 'Write' });
  const tabMetrics = await writeTab.evaluate((element) => {
    const style = getComputedStyle(element);
    const label = element.querySelector('.squisq-toolbar-view-tab-label--long');
    const labelRect = label?.getBoundingClientRect();
    const toolbarRect = element.closest('.squisq-toolbar')?.getBoundingClientRect();
    return {
      paddingTop: style.paddingTop,
      paddingBottom: style.paddingBottom,
      centerDelta:
        labelRect && toolbarRect
          ? labelRect.top + labelRect.height / 2 - (toolbarRect.top + toolbarRect.height / 2)
          : null,
    };
  });
  expect(tabMetrics.paddingTop).toBe('4px');
  expect(tabMetrics.paddingBottom).toBe('9px');
  expect(tabMetrics.centerDelta).not.toBeNull();
  // Chromium can place text boxes on quarter pixels, so allow the label's
  // geometric center to differ slightly while still catching the old 48px
  // toolbar padding override.
  expect(Math.abs(tabMetrics.centerDelta ?? Infinity)).toBeLessThanOrEqual(1.5);

  // The sidebar titlebar ends with a desktop-only dotted grip so the
  // draggable space beside the workspace gear is visually discoverable.
  const sidebarHeader = window.locator('.db-shell-sidebar-header');
  const gripElement = sidebarHeader.locator('.db-window-drag-grip');
  const grip = await gripElement.evaluate((element) => {
    const style = getComputedStyle(element);
    const headerRect = element.getBoundingClientRect();
    const gutterTarget = document.elementFromPoint(
      headerRect.right - 4,
      headerRect.top + headerRect.height / 2,
    );
    const gutterGrip = gutterTarget?.closest('.db-window-drag-grip');
    const gutterStyle = gutterGrip ? getComputedStyle(gutterGrip) : null;
    return {
      width: style.width,
      paddingRight: style.paddingRight,
      backgroundImage: style.backgroundImage,
      cursor: style.cursor,
      appRegion:
        style.getPropertyValue('-webkit-app-region') || style.getPropertyValue('app-region'),
      gutterIsGrip: gutterGrip === element,
      gutterAppRegion:
        gutterStyle?.getPropertyValue('-webkit-app-region') ||
        gutterStyle?.getPropertyValue('app-region'),
    };
  });
  expect(grip.width).toBe('20px');
  expect(grip.paddingRight).toBe('8px');
  expect(grip.backgroundImage).toContain('radial-gradient');
  expect(grip.cursor).toBe('grab');
  expect(grip.appRegion).toBe('drag');
  expect(grip.gutterIsGrip).toBe(true);
  expect(grip.gutterAppRegion).toBe('drag');

  // Interactive controls inside the drag region must remain clickable.
  await sidebarHeader.getByRole('button', { name: 'Workspace settings' }).click();
  await expect(window.getByRole('menuitem', { name: /Workspace settings/ })).toBeVisible();
  const sourceTab = toolbar.getByRole('tab', { name: 'Source' });
  await sourceTab.click();
  await expect(sourceTab).toHaveClass(/squisq-toolbar-view-tab--active/);

  // macOS owns its global application menu outside the BrowserWindow;
  // Windows/Linux should have no in-window File/Edit/View menu row.
  if (process.platform !== 'darwin') {
    await expect(window.locator('.db-shell [role="menubar"]')).toHaveCount(0);
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
  const canonicalWorkspaceDir = fs.realpathSync.native(workspaceDir);

  await window.locator('.db-workspace-picker-btn').click();
  const activeWorkspace = window.locator('.db-workspace-dropdown-item--active');
  await expect(activeWorkspace.locator('.db-workspace-path')).toHaveText(canonicalWorkspaceDir);
  await expect(activeWorkspace.locator('.db-workspace-path')).toHaveAttribute(
    'title',
    canonicalWorkspaceDir,
  );
});

test('seeds aboutDocBlocks.md on first launch', async ({ launchApp, workspaceDir }) => {
  const { window } = await launchApp();
  await window.waitForSelector('.db-shell', { timeout: 30_000 });
  const welcome = path.join(workspaceDir, 'aboutDocBlocks.md');
  // The shell seeds the welcome doc asynchronously. Poll the behavior this
  // test owns instead of coupling readiness to mutable rendered copy.
  await expect.poll(() => fs.existsSync(welcome), { timeout: 15_000 }).toBe(true);
  expect(fs.readFileSync(welcome, 'utf8')).toContain(
    '# DocBlocks: one Markdown file, many finished forms',
  );
});

test('export dialog exposes a remembered native target control', async ({ launchApp }) => {
  const { window } = await launchApp();
  await window.waitForSelector('.db-shell', { timeout: 30_000 });
  await window.locator('.db-toolbar-menu-trigger').click();
  await window.getByRole('menuitem', { name: 'Export...' }).click();

  const exportTarget = window.getByLabel('Export to');
  await expect(exportTarget).toBeVisible();
  await expect(exportTarget).toHaveValue(/aboutDocBlocks\.pdf$/);
  await expect(window.getByRole('button', { name: 'Choose export location' })).toBeVisible();
});

test('exports exact Markdown bytes through the remembered native target', async ({
  launchApp,
  userDataDir,
  workspaceDir,
}) => {
  const target = path.join(userDataDir, 'exported-about.md');
  prepareRememberedExportTarget(userDataDir, workspaceDir, target);
  const { window } = await launchApp();
  await window.waitForSelector('.db-shell', { timeout: 30_000 });

  await window.locator('.db-toolbar-menu-trigger').click();
  await window.getByRole('menuitem', { name: 'Export...' }).click();
  const dialog = window.getByRole('dialog', { name: 'Export Document' });
  await dialog.getByRole('radio', { name: 'Markdown' }).click();
  await expect(dialog.getByLabel('Export to')).toHaveValue(target);
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();

  await expect.poll(() => fs.existsSync(target), { timeout: 20_000 }).toBe(true);
  const exported = fs.readFileSync(target, 'utf8');
  expect(exported.length).toBeGreaterThan(100);
  expect(exported).toContain('# DocBlocks: one Markdown file, many finished forms');
});

test('content persists across relaunch', async ({ launchApp, workspaceDir }) => {
  // First launch: write a file directly (avoids brittle UI typing).
  const first = await launchApp();
  await first.window.waitForSelector('.db-shell', { timeout: 30_000 });
  const target = path.join(workspaceDir, 'e2e-test.md');
  fs.writeFileSync(target, '# Hello from e2e\nsome body text\n', 'utf8');
  await first.close();

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
  const { window } = await launchApp();
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

  // Exercise the guarded BrowserWindow close path directly. Production macOS
  // builds remain active after the final window closes, but automation mode
  // exits so a headless application cannot strand the Playwright worker.
  const windowClosed = window.waitForEvent('close');
  await requestWindowClose(window);
  await windowClosed;
  const welcome = path.join(workspaceDir, 'aboutDocBlocks.md');
  expect(fs.readFileSync(welcome, 'utf8')).toContain(sentinel);
});

test('quick close flushes a loose OS-opened file through its origin target', async ({
  launchApp,
  userDataDir,
}) => {
  const externalFile = path.join(userDataDir, 'quick-close.md');
  fs.writeFileSync(externalFile, '# Loose origin\n', 'utf8');
  const { close, window } = await launchApp([externalFile]);
  const editor = window.locator('[contenteditable="true"]').first();
  await expect(editor).toContainText('Loose origin', { timeout: 30_000 });

  const sentinel = `loose-close-${Date.now()}`;
  await editor.click();
  await window.keyboard.press('Control+End');
  await window.keyboard.press('Enter');
  await window.keyboard.insertText(sentinel);
  await expect(editor).toContainText(sentinel);

  await close();
  expect(fs.readFileSync(externalFile, 'utf8')).toContain(sentinel);
});

test('quick close repacks a DBK origin before acknowledging window destruction', async ({
  launchApp,
  userDataDir,
}) => {
  const externalBundle = path.join(userDataDir, 'quick-bundle.dbk');
  const source = new MemoryContentContainer();
  await source.writeFile(
    'quick-bundle.md',
    new TextEncoder().encode('# Bundle origin\n'),
    'text/markdown',
  );
  const sourceBlob = await containerToZip(source);
  fs.writeFileSync(externalBundle, Buffer.from(await sourceBlob.arrayBuffer()));

  const { close, window } = await launchApp([externalBundle]);
  const editor = window.locator('[contenteditable="true"]').first();
  await expect(editor).toContainText('Bundle origin', { timeout: 30_000 });

  const sentinel = `bundle-close-${Date.now()}`;
  await editor.click();
  await window.keyboard.press('Control+End');
  await window.keyboard.press('Enter');
  await window.keyboard.insertText(sentinel);
  await expect(editor).toContainText(sentinel);

  await close();
  const committed = await zipToContainer(fs.readFileSync(externalBundle));
  const committedDocument = await committed.readFile('quick-bundle.md');
  expect(new TextDecoder().decode(committedDocument ?? undefined)).toContain(sentinel);
});

test('keeping a local DBK conflict saves durable content without replaying the stale memory baseline', async ({
  launchApp,
  userDataDir,
}) => {
  const externalBundle = path.join(userDataDir, 'conflicted-bundle.dbk');
  const documentName = 'conflicted-bundle.md';
  await writeDbkDocument(externalBundle, documentName, '# Baseline A\n');

  const { close, window } = await launchApp([externalBundle]);
  const editor = window.locator('[contenteditable="true"]').first();
  await expect(editor).toContainText('Baseline A', { timeout: 30_000 });

  // Change the origin to B without changing the transient provider, then
  // create local branch C. The first autosave must enter conflict.
  await writeDbkDocument(externalBundle, documentName, '# External B\n');
  const sentinel = `Local C ${Date.now()}`;
  await editor.click();
  await window.keyboard.press('Control+End');
  await window.keyboard.press('Enter');
  await window.keyboard.insertText(sentinel);

  const keepMine = window.getByRole('button', { name: 'Keep mine' });
  await expect(keepMine).toBeVisible({ timeout: 15_000 });
  await keepMine.click();

  await expect(window.getByText('Your version was saved.')).toBeVisible({ timeout: 15_000 });
  await expect(keepMine).toBeHidden();
  await expect
    .poll(async () => readDbkDocument(externalBundle, documentName), { timeout: 15_000 })
    .toContain(sentinel);
  await close();
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

async function requestWindowClose(window: import('@playwright/test').Page): Promise<void> {
  await window.evaluate(() => {
    const host = (
      globalThis as {
        docBlocksHost?: { lifecycle?: { requestWindowClose(): void } };
      }
    ).docBlocksHost;
    if (!host?.lifecycle) throw new Error('Desktop lifecycle API is unavailable.');
    host.lifecycle.requestWindowClose();
  });
}

async function writeDbkDocument(filePath: string, documentName: string, content: string) {
  const container = new MemoryContentContainer();
  await container.writeFile(documentName, new TextEncoder().encode(content), 'text/markdown');
  const blob = await containerToZip(container);
  fs.writeFileSync(filePath, Buffer.from(await blob.arrayBuffer()));
}

async function readDbkDocument(filePath: string, documentName: string): Promise<string> {
  try {
    const container = await zipToContainer(fs.readFileSync(filePath));
    const content = await container.readFile(documentName);
    return new TextDecoder().decode(content ?? undefined);
  } catch {
    // Poll through the origin's atomic replacement window.
    return '';
  }
}

function prepareRememberedExportTarget(
  userDataDir: string,
  workspaceDir: string,
  target: string,
): void {
  const workspaceId = deriveWorkspaceId(fs.realpathSync.native(workspaceDir));
  const access = { path: target, confirmedByPicker: true as const };
  const exportTargets: Record<string, { last: typeof access; byExtension: { md: typeof access } }> =
    {};
  for (const selectedFile of ['aboutDocBlocks.md', '/aboutDocBlocks.md']) {
    const documentId = JSON.stringify([workspaceId, selectedFile]);
    const key = createHash('sha256').update(documentId).digest('hex');
    exportTargets[key] = { last: access, byExtension: { md: access } };
  }
  fs.writeFileSync(
    path.join(userDataDir, 'settings.json'),
    JSON.stringify({ workspaces: [], exportTargets }),
    'utf8',
  );
}
