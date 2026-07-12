import { expect, type Page } from '@playwright/test';

/**
 * Open a fresh site context and wait for the asynchronous first-run workspace
 * transaction to finish. Shell/toolbars render before IndexedDB creation,
 * welcome-file seeding, hash navigation, and the lazy editor have completed;
 * tests that acted at that earlier point raced the initialization effect.
 */
export async function openInitializedSite(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await expect(page.locator('.db-shell')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.db-explorer-toolbar')).toBeVisible({ timeout: 15_000 });

  const welcomeRow = page.locator('.db-tree-row', { hasText: 'aboutDocBlocks' });
  await expect(welcomeRow).toBeVisible({ timeout: 15_000 });

  await expect
    .poll(() => decodeURIComponent(new URL(page.url()).hash), { timeout: 15_000 })
    .toMatch(/\/aboutDocBlocks\.md$/i);

  // The gateway proves the selected welcome document branch has rendered;
  // the status item proves the lazy Squisq shell has finished mounting.
  await expect(page.locator('.db-welcome-gateway')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.squisq-status-item').first()).toBeVisible({ timeout: 15_000 });
}
