import { expect, type Page } from '@playwright/test';

// The first request to the Vite dev server can spend materially longer than
// subsequent tests transforming the site and its editor dependencies,
// especially on Windows. Keep startup bounded without making ordinary test
// actions inherit this larger allowance.
const SITE_STARTUP_TIMEOUT_MS = 45_000;

/**
 * Open a fresh site context and wait for the asynchronous first-run workspace
 * transaction to finish. Shell/toolbars render before IndexedDB creation,
 * welcome-file seeding, hash navigation, and the lazy editor have completed;
 * tests that acted at that earlier point raced the initialization effect.
 */
export async function openInitializedSite(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await expect(page.locator('.db-shell')).toBeVisible({ timeout: SITE_STARTUP_TIMEOUT_MS });
  await expect(page.locator('.db-explorer-toolbar')).toBeVisible({
    timeout: SITE_STARTUP_TIMEOUT_MS,
  });

  const welcomeRow = page.locator('.db-tree-row', { hasText: 'aboutDocBlocks' });
  await expect(welcomeRow).toBeVisible({ timeout: SITE_STARTUP_TIMEOUT_MS });

  await expect
    .poll(() => decodeURIComponent(new URL(page.url()).hash), {
      timeout: SITE_STARTUP_TIMEOUT_MS,
    })
    .toMatch(/\/aboutDocBlocks\.md$/i);

  // The gateway proves the selected welcome document branch has rendered;
  // the status item proves the lazy Squisq shell has finished mounting.
  await expect(page.locator('.db-welcome-gateway')).toBeVisible({
    timeout: SITE_STARTUP_TIMEOUT_MS,
  });
  await expect(page.locator('.squisq-status-item').first()).toBeVisible({
    timeout: SITE_STARTUP_TIMEOUT_MS,
  });
}
