import { test, expect } from '@playwright/test';
import { copyFile, rm } from 'node:fs/promises';
import path from 'node:path';

// Runs under playwright.offline.config.ts (vite preview over a production
// build) — the only environment where the service worker exists. See that
// config's header comment.

test.describe('DocBlocks offline (PWA)', () => {
  const legacyWorkerName = 'legacy-navigation-worker.fixture.js';
  const legacyWorkerSource = path.join(
    process.cwd(),
    'e2e',
    'fixtures',
    'legacy-navigation-worker.js',
  );
  const legacyWorkerDestination = path.join(
    process.cwd(),
    'packages',
    'site',
    'dist',
    legacyWorkerName,
  );

  test.beforeAll(async () => {
    await copyFile(legacyWorkerSource, legacyWorkerDestination);
  });

  test.afterAll(async () => {
    await rm(legacyWorkerDestination, { force: true });
  });

  test('automatically migrates clients controlled by the legacy catch-all worker', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto('/desktop/');
    await page.evaluate(async (scriptName) => {
      await caches.delete('docblocks-pwa-migrations');
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
      await navigator.serviceWorker.register(`/${scriptName}`, { scope: '/' });
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller?.scriptURL.includes(scriptName)) {
        await new Promise<void>((resolve) => {
          navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
            once: true,
          });
        });
      }
    }, legacyWorkerName);

    // The legacy worker turns this static route into the editor shell. Loading
    // that shell registers the corrected worker, whose one-time migration
    // hook skips waiting and claims this client.
    await page.reload();
    await expect(page.locator('.db-shell')).toBeVisible({ timeout: 20_000 });
    await page.waitForFunction(
      () => navigator.serviceWorker.controller?.scriptURL.endsWith('/sw.js') === true,
      undefined,
      { timeout: 45_000 },
    );

    await page.goto('/desktop/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'Your Markdown. Your folders.',
    );
    await expect(page.locator('.db-shell')).toHaveCount(0);
  });

  test('reports a first-install cache quota failure without breaking the online editor', async ({
    page,
    context,
  }) => {
    test.setTimeout(90_000);
    const devtools = await context.newCDPSession(page);
    await devtools.send('Storage.overrideQuotaForOrigin', {
      origin: 'http://localhost:5230',
      // Enough for normal IndexedDB startup, deliberately below the checked
      // ~55 MiB application precache (including the deferred ffmpeg core).
      quotaSize: 4 * 1024 * 1024,
    });
    try {
      await page.goto('/');
      await expect(page.locator('.db-shell')).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('.db-pwa-install-error')).toContainText(
        'could not finish caching the app for offline use',
        { timeout: 45_000 },
      );
      await expect(page.locator('.db-pwa-install-error')).toContainText(
        'The online editor still works',
      );
    } finally {
      await devtools.detach();
    }
  });

  test('precaches the full app and works offline end-to-end', async ({ page, context }) => {
    // The first visit downloads the whole ~55 MB precache in the background.
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
    // 6 MB Monaco ts.worker, 31 MB ffmpeg core, and theme fonts — actually made it in.
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
    expect(precachedUrls.some((url) => /ffmpeg-core\/ffmpeg-core\.wasm/.test(url))).toBeTruthy();

    // The one-time legacy-route migration claims a fresh installation. A
    // reload remains useful here to exercise a cold controlled navigation;
    // later releases still use the normal prompt-based update lifecycle.
    await page.reload();
    await expect(page.locator('.db-shell')).toBeVisible({ timeout: 10_000 });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

    // Static product and crawl routes are precached as their own resources;
    // the root-only navigation fallback must never replace them with the app.
    const robotsPage = await context.newPage();
    await robotsPage.goto('/robots.txt');
    await expect(robotsPage.locator('body')).toContainText(
      'Sitemap: https://docblocks.com/sitemap.xml',
    );
    await robotsPage.close();

    const desktopPage = await context.newPage();
    await desktopPage.goto('/desktop/');
    await expect(desktopPage.getByRole('heading', { level: 1 })).toContainText(
      'Your Markdown. Your folders.',
    );
    await desktopPage.close();

    // Cold start while offline: navigation falls back to the precached
    // index.html and every asset serves from the cache.
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('.db-shell')).toBeVisible({ timeout: 15_000 });
    expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);

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
