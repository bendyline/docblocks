import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // The offline/PWA spec needs a production build (the service worker never
  // registers on the dev server this config starts) — it runs from
  // playwright.offline.config.ts via `npm run test:e2e:offline`.
  testIgnore: ['**/offline.spec.ts', '**/cross-browser.spec.ts'],
  // Site tests exercise a first-run IndexedDB workspace at one origin. Keep
  // them serialized so startup, seeding, and mutation assertions are not
  // competing for browser/storage resources on high-core developer machines.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // A deterministic harness should fail on the first run. Retries previously
  // hid readiness races locally and made CI substantially slower on failures.
  retries: 0,
  workers: 1,
  reporter: [['html', { open: 'never' }]],
  // Allow the first Windows dev-server request to transform the full editor
  // graph. Per-action assertions retain their tighter explicit timeouts.
  timeout: 60_000,
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
      ? 'npm run dev -w docblocks-site -- --strictPort'
      : 'npm run build && npm run dev -w docblocks-site -- --strictPort',
    url: 'http://localhost:5220',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
