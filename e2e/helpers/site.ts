import { expect, type Page } from '@playwright/test';

// The first request to the Vite dev server can spend materially longer than
// subsequent tests transforming the site and its editor dependencies,
// especially on Windows. Keep startup bounded without making ordinary test
// actions inherit this larger allowance.
const SITE_STARTUP_TIMEOUT_MS = 75_000;

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

  const welcomeRow = page.locator(
    '.db-tree-row[data-path="aboutDocBlocks.md"], .db-tree-row[data-path="/aboutDocBlocks.md"]',
  );
  const startupError = page.locator('.db-save-toast--error');
  await expect(welcomeRow.or(startupError)).toBeVisible({ timeout: SITE_STARTUP_TIMEOUT_MS });
  if (await startupError.isVisible()) {
    throw new Error(`Site workspace initialization failed: ${await startupError.innerText()}`);
  }

  await expect
    .poll(() => decodeURIComponent(new URL(page.url()).hash), {
      timeout: SITE_STARTUP_TIMEOUT_MS,
    })
    .toMatch(/\/aboutDocBlocks\.md$/i);

  // The status item proves the selected document's lazy Squisq shell has
  // finished mounting. The welcome gateway is intentionally transient and
  // can disappear before this assertion on a warm dev server.
  await expect(page.locator('.squisq-status-item').first()).toBeVisible({
    timeout: SITE_STARTUP_TIMEOUT_MS,
  });
}
