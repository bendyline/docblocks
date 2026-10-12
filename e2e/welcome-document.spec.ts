import type { Page } from '@playwright/test';
import { openInitializedSite } from './helpers/site.js';
import { expect, test } from './helpers/test.js';

/**
 * The starter document belongs to the app's own default workspace only.
 * Startup used to write it into *any* empty workspace it restored with no
 * file selected — including a folder the user had just created or opened —
 * so a reload right after creating a workspace left an `aboutDocBlocks.md`
 * behind in it.
 */

function welcomeRow(page: Page) {
  return page.locator(
    '.db-tree-row[data-path="aboutDocBlocks.md"], .db-tree-row[data-path="/aboutDocBlocks.md"]',
  );
}

test('seeds the starter document only into the default workspace', async ({ page }) => {
  // First run: the default workspace gets the starter document.
  await openInitializedSite(page);
  await expect(welcomeRow(page)).toBeVisible();

  await page.getByRole('button', { name: /Switch workspace/ }).click();
  await page.getByRole('button', { name: 'New Workspace' }).click();
  await page.getByLabel('Workspace name').fill('Empty notes');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const current = page.getByRole('button', { name: 'Switch workspace, current: Empty notes' });
  await expect(current).toBeVisible();
  await expect(welcomeRow(page)).toHaveCount(0);

  // Reloading restores the new workspace from the URL with no file selected.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(current).toBeVisible({ timeout: 75_000 });
  await expect(page.locator('.db-workspace-empty-content')).toBeVisible();
  // Startup seeding ran after the workspace mounted; give it time to (not) write.
  await page.waitForTimeout(1_500);
  await expect(welcomeRow(page)).toHaveCount(0);
  expect(decodeURIComponent(new URL(page.url()).hash)).not.toMatch(/aboutDocBlocks/i);
});
