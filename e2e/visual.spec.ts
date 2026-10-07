/**
 * Visual regression baselines for the site shell.
 *
 * These do not duplicate the functional suite: `app.spec.ts` asserts computed
 * colors and measured geometry, which proves a token resolved but says nothing
 * about whether the result is laid out, legible, or complete. A portaled Squisq
 * menu whose text overflows its panel passes every color assertion.
 *
 * Baselines are captured on Linux and compared there; see the project
 * definitions in `playwright.config.ts`. Run with `npm run test:e2e:visual`.
 *
 * Each capture is element-scoped wherever the state is an element. A viewport
 * shot commits a megabyte and drifts on anything that moves; a dialog shot
 * commits a few tens of kilobytes and fails only for the dialog.
 */

import { expect, test } from './helpers/test.js';
import { openInitializedSite } from './helpers/site.js';
import { expectStableScreenshot } from './helpers/visual.js';
import type { Page } from '@playwright/test';

/**
 * Seed theme and accent before first paint.
 *
 * The shell reads these during mount, so setting them afterwards would capture
 * a re-themed frame rather than the theme under test.
 */
async function seedAppearance(
  page: Page,
  appearance: { theme?: 'light' | 'dark'; accent?: string } = {},
): Promise<void> {
  await page.addInitScript((seed) => {
    if (seed.theme) localStorage.setItem('docblocks:themePreference', seed.theme);
    if (seed.accent) localStorage.setItem('docblocks:accentColor', seed.accent);
    // Pin the chrome to the bundled face. Under the default `system` stack the
    // shell resolves `system-ui` to a different typeface on each platform, so
    // the same screenshot could never match across operating systems — and a
    // Linux baseline would render in whatever that runner resolves, which is a
    // font essentially no DocBlocks user has.
    localStorage.setItem('docblocks:interfaceFont', 'fixed');
  }, appearance);
}

/** Open the welcome document and wait for the editor to be interactive. */
async function openEditor(page: Page): Promise<void> {
  await page.locator('.db-welcome-gateway-cta').click();
  await expect(page.locator('[contenteditable="true"]').first()).toBeVisible({ timeout: 20_000 });
}

test.describe('shell', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`editor at rest (${theme})`, async ({ page }) => {
      await seedAppearance(page, { theme });
      await openInitializedSite(page);
      await expect(page.locator(`.db-shell[data-theme="${theme}"]`)).toBeVisible();
      await openEditor(page);
      // The whole shell: this is the one capture where the relationship between
      // sidebar, toolbar, editor and status bar is the subject.
      await expectStableScreenshot(page, page.locator('.db-shell'), `shell-${theme}.png`);
    });
  }

  test('welcome gateway on first run', async ({ page }) => {
    await seedAppearance(page, { theme: 'dark' });
    await openInitializedSite(page);
    const gateway = page.locator('.db-welcome-gateway');
    await expect(gateway).toBeVisible({ timeout: 20_000 });
    await expectStableScreenshot(page, gateway, 'welcome-gateway.png');
  });

  test('app menu', async ({ page }) => {
    await seedAppearance(page, { theme: 'dark' });
    await openInitializedSite(page);
    await page.locator('.db-app-menu-btn').click();
    const menu = page.locator('.db-app-menu-dropdown');
    await expect(menu).toBeVisible();
    await expectStableScreenshot(page, menu, 'app-menu.png');
  });

  test('workspace picker dropdown', async ({ page }) => {
    await seedAppearance(page, { theme: 'dark' });
    await openInitializedSite(page);
    await page.locator('.db-workspace-picker-btn').click();
    const dropdown = page.locator('.db-workspace-dropdown');
    await expect(dropdown).toBeVisible();
    await expectStableScreenshot(page, dropdown, 'workspace-dropdown.png');
  });

  test('file context menu portaled out of the shell', async ({ page }) => {
    await seedAppearance(page, { theme: 'dark' });
    await openInitializedSite(page);
    const row = page.locator('.db-tree-row', { hasText: 'aboutDocBlocks' }).first();
    await row.hover();
    await row.locator('.db-tree-more').click();
    const menu = page.locator('.db-tree-context');
    await expect(menu).toBeVisible();
    await expectStableScreenshot(page, menu, 'file-context-menu.png');
  });

  test('new file input', async ({ page }) => {
    await seedAppearance(page, { theme: 'dark' });
    await openInitializedSite(page);
    await page.getByRole('button', { name: 'New File' }).click();
    const input = page.locator('.db-new-item-input');
    await expect(input).toBeVisible();
    // Scope to the toolbar row so the inline form and its buttons are framed
    // together; the bare input alone would not show the confirm affordance.
    await expectStableScreenshot(page, page.locator('.db-explorer-toolbar'), 'new-file-input.png');
  });
});

test.describe('dialogs', () => {
  test('settings', async ({ page }) => {
    await seedAppearance(page, { theme: 'dark' });
    await openInitializedSite(page);
    await page.locator('.db-app-menu-btn').click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(dialog).toBeVisible();
    await expectStableScreenshot(page, dialog, 'settings-dialog.png');
  });

  test('settings reflows in a compact viewport', async ({ page }) => {
    await seedAppearance(page, { theme: 'dark' });
    await openInitializedSite(page);
    await page.setViewportSize({ width: 460, height: 460 });
    await page.locator('.db-app-menu-btn').click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(dialog).toBeVisible();
    await expectStableScreenshot(page, dialog, 'settings-dialog-compact.png');
  });

  test('about', async ({ page }) => {
    await seedAppearance(page, { theme: 'dark' });
    await openInitializedSite(page);
    await page.locator('.db-app-menu-btn').click();
    await page.getByRole('menuitem', { name: /About/ }).click();
    const dialog = page.getByRole('dialog', { name: 'About DocBlocks' });
    await expect(dialog).toBeVisible();
    // The version string changes every release and is not what this baseline is
    // about, so it is masked rather than re-captured on each bump.
    await expectStableScreenshot(page, dialog, 'about-dialog.png', {
      mask: [dialog.locator('.db-about-version')],
    });
  });

  test('export document', async ({ page }) => {
    await seedAppearance(page, { theme: 'dark' });
    await openInitializedSite(page);
    await openEditor(page);
    await page.getByRole('button', { name: 'Export and share' }).click();
    await page.getByRole('menuitem', { name: 'Export document...' }).click();
    const dialog = page.getByRole('dialog', { name: 'Export Document' });
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await expectStableScreenshot(page, dialog, 'export-dialog.png');
  });
});

test.describe('portaled Squisq surfaces', () => {
  // These render outside `.db-shell` through a portal, which is exactly where
  // theme tokens stop being inherited. A diff catches the whole surface, not
  // only the two or three properties a color assertion names.

  test('toolbar overflow menu', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await seedAppearance(page, { theme: 'dark' });
    await openInitializedSite(page);
    await openEditor(page);
    await page.locator('.squisq-toolbar-overflow-trigger').click();
    const menu = page.locator('.squisq-toolbar-overflow-menu');
    await expect(menu).toBeVisible();
    await expectStableScreenshot(page, menu, 'squisq-overflow-menu.png');
  });

  test('insert menu with a brown accent', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await seedAppearance(page, { theme: 'dark', accent: 'brown' });
    await openInitializedSite(page);
    await openEditor(page);
    await page.locator('.squisq-toolbar-overflow-trigger').click();
    const overflow = page.locator('.squisq-toolbar-overflow-menu');
    await expect(overflow).toBeVisible();
    await overflow.getByRole('button', { name: 'Insert...' }).click();
    const insertMenu = page.locator('.squisq-insert-menu').first();
    await expect(insertMenu).toBeVisible();
    await expectStableScreenshot(page, insertMenu, 'squisq-insert-menu.png');
  });

  test('use mode menu with a purple accent', async ({ page }) => {
    await seedAppearance(page, { theme: 'dark', accent: 'purple' });
    await openInitializedSite(page);
    await openEditor(page);
    await page.getByRole('button', { name: 'Choose Use mode' }).click();
    const menu = page.getByRole('menu', { name: 'Use mode' });
    await expect(menu).toBeVisible();
    await expectStableScreenshot(page, menu, 'squisq-use-mode-menu.png');
  });

  test('block type picker with a green accent', async ({ page }) => {
    await seedAppearance(page, { theme: 'dark', accent: 'green' });
    await openInitializedSite(page);
    await openEditor(page);
    const heading = page.locator('.tiptap.ProseMirror').locator('h1, h2, h3').first();
    await heading.click({ position: { x: 8, y: 8 } });
    const trigger = heading.locator('.squisq-template-badge').first();
    await expect(trigger).toBeVisible();
    await trigger.click();
    const dialog = page.locator(
      '.squisq-template-gallery-dialog:has([data-squisq-template-gallery-portal])',
    );
    await expect(dialog).toBeVisible();
    await expectStableScreenshot(page, dialog, 'squisq-block-type-picker.png');
  });

  test('custom layout manager with a green accent', async ({ page }) => {
    await seedAppearance(page, { theme: 'dark', accent: 'green' });
    await openInitializedSite(page);
    await openEditor(page);
    await page.getByRole('button', { name: 'Custom layouts' }).click();
    const dialog = page.getByRole('dialog', { name: 'Custom layouts' });
    await expect(dialog).toBeVisible();
    await expectStableScreenshot(page, dialog, 'squisq-custom-layouts.png');
  });
});

test.describe('editor toolbar layout', () => {
  // The wrap threshold is a layout contract: `toolbar-wrapping.spec.ts` asserts
  // the marker class and a height, these prove the two rows are actually usable.

  test('wraps to two rows in a narrow window', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await seedAppearance(page, { theme: 'dark' });
    await openInitializedSite(page);
    await openEditor(page);
    await expect(page.locator('.db-shell.db-shell--desktop-toolbar-wrapped')).toBeVisible();
    await expectStableScreenshot(page, page.locator('.squisq-toolbar'), 'toolbar-wrapped.png');
  });

  test('stays on one row when the editor pane has room', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedAppearance(page, { theme: 'dark' });
    await openInitializedSite(page);
    await openEditor(page);
    await expect(page.locator('.db-shell.db-shell--desktop-toolbar-wrapped')).toHaveCount(0);
    await expectStableScreenshot(page, page.locator('.squisq-toolbar'), 'toolbar-single-row.png');
  });
});

test.describe('marketing pages', () => {
  // Static routes with no application state, so these are the most stable
  // baselines in the suite and the cheapest early warning for a CSS regression.
  for (const route of ['desktop', 'vscode', 'cli', 'formats'] as const) {
    test(`${route} page`, async ({ page }) => {
      await page.goto(`/${route}/`);
      await expect(page.locator('.site-header')).toBeVisible();
      await expectStableScreenshot(page, page, `marketing-${route}.png`);
    });
  }
});
