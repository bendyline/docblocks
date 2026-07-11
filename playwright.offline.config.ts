import { defineConfig, devices } from '@playwright/test';

// Offline/PWA e2e. The service worker only exists in production builds
// (devOptions is disabled in the site's VitePWA config), so this config runs
// against `vite preview` over packages/site/dist. The default
// playwright.config.ts drives the dev server — where the SW never registers —
// and testIgnores offline.spec.ts for exactly that reason.
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/offline.spec.ts',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  // Separate output folder so a CI run cannot clobber the default suite's
  // playwright-report/ artifact.
  reporter: [['html', { outputFolder: 'playwright-report-offline' }]],
  use: {
    baseURL: 'http://localhost:5230',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // CI's e2e job runs `npm run build` as its own step, so preview can start
    // directly. Locally the site build keeps `npm run test:e2e:offline`
    // self-contained (core/react must have been built at least once).
    command: process.env.CI
      ? 'npm run preview -w docblocks-site -- --port 5230 --strictPort'
      : 'npm run build -w docblocks-site && npm run preview -w docblocks-site -- --port 5230 --strictPort',
    url: 'http://localhost:5230',
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
});
