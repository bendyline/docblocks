import { test, expect } from '@playwright/test';

// Runs under playwright.offline.config.ts (vite preview over a production
// build) — the only environment where the service worker exists. See that
// config's header comment.

test.describe('DocBlocks offline (PWA)', () => {
  test('precaches the full app and works offline end-to-end', async ({ page, context }) => {
    // The first visit downloads the whole ~22 MB precache in the background.
    test.setTimeout(180_000);

    await page.goto('/');
    await expect(page.locator('.db-shell')).toBeVisible({ timeout: 10_000 });

    // `ready` resolves after activation; precaching happens during install,
    // so this also means the full precache completed.
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });

    // Precache completeness: `maximumFileSizeToCacheInBytes` silently drops
    // anything above its cap, so assert the two families most at risk — the
    // 6 MB Monaco ts.worker and the theme fonts — actually made it in.
    const precachedUrls = await page.evaluate(async () => {
      const names = await caches.keys();
      const precacheName = names.find((name) => name.includes('precache'));
      if (!precacheName) return [];
      const cache = await caches.open(precacheName);
      const keys = await cache.keys();
      return keys.map((request) => request.url);
    });
    expect(precachedUrls.length).toBeGreaterThan(50);
    expect(precachedUrls.some((url) => /ts\.worker/.test(url))).toBeTruthy();
    expect(precachedUrls.some((url) => /fonts\/.+\.woff2/.test(url))).toBeTruthy();

    // No clientsClaim (prompt-based updates), so the first load is not
    // controlled — reload once to come under SW control.
    await page.reload();
    await expect(page.locator('.db-shell')).toBeVisible({ timeout: 10_000 });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

    // Cold start while offline: navigation falls back to the precached
    // index.html and every asset serves from the cache.
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('.db-shell')).toBeVisible({ timeout: 15_000 });

    // Edit and save offline — documents live in IndexedDB, which needs no
    // network. The welcome gateway only shows on a fresh session, so click
    // through it if present.
    const gatewayCta = page.locator('.db-welcome-gateway-cta');
    if (await gatewayCta.isVisible().catch(() => false)) {
      await gatewayCta.click();
    }
    const editor = page.locator('[contenteditable="true"]').first();
    await expect(editor).toBeVisible({ timeout: 15_000 });
    await editor.click();
    await page.keyboard.type('Offline note from the e2e suite. ');
    await expect(page.locator('.db-shell[data-document-status="saved"]')).toBeVisible({
      timeout: 10_000,
    });

    // Still offline: a full reload must bring the edit back from IndexedDB.
    await page.reload();
    await expect(page.locator('.db-shell')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[contenteditable="true"]').first()).toContainText(
      'Offline note from the e2e suite.',
      { timeout: 15_000 },
    );
  });
});
