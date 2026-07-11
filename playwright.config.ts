import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // The offline/PWA spec needs a production build (the service worker never
  // registers on the dev server this config starts) — it runs from
  // playwright.offline.config.ts via `npm run test:e2e:offline`.
  testIgnore: '**/offline.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:5220',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // CI builds upstream packages as a separate step before e2e runs, so we
    // can skip the build here and start the dev server directly. Locally the
    // build keeps things self-contained so `npm run test:e2e` just works.
    command: process.env.CI
      ? 'npm run dev -w docblocks-site'
      : 'npm run build && npm run dev -w docblocks-site',
    url: 'http://localhost:5220',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
