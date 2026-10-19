import { defineConfig, devices } from '@playwright/test';

/** Specs that run on the touch-emulating device projects instead of chromium. */
const ADAPTIVE_SPECS = /adaptive-.*\.spec\.ts/;

/**
 * Suites with their own config: offline needs a production preview server and
 * cross-browser drives firefox/webkit.
 */
const ROOT_TEST_IGNORE = ['**/offline.spec.ts', '**/cross-browser.spec.ts'];

export default defineConfig({
  testDir: './e2e',
  // The offline/PWA spec needs a production build (the service worker never
  // registers on the dev server this config starts) — it runs from
  // playwright.offline.config.ts via `npm run test:e2e:offline`.
  testIgnore: ROOT_TEST_IGNORE,
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
  timeout: 90_000,
  use: {
    baseURL: 'http://localhost:5220',
    trace: 'on-first-retry',
  },
  // Device projects are added here rather than behind a new `test:e2e:*`
  // script: scripts/check-assurance-contract.ts pins the exact suite list in
  // two places and ci.yml mirrors it, so a new script means editing the
  // contract and five workflow requirement lists for no added coverage.
  // `ADAPTIVE_SPECS` keeps the 1200-line app.spec.ts off the device projects
  // and keeps the desktop project off the touch-only assertions.
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      // A project-level testIgnore REPLACES the top-level one rather than
      // adding to it, so the suites excluded above must be repeated here or
      // they silently start running on this project.
      testIgnore: [...ROOT_TEST_IGNORE, ADAPTIVE_SPECS],
    },
    // 390x664 webkit, hasTouch + isMobile: the closest CI-runnable proxy for
    // iOS Safari and, later, the Capacitor WKWebView.
    {
      name: 'iphone-13',
      use: { ...devices['iPhone 13'] },
      testMatch: ADAPTIVE_SPECS,
    },
    // 412x839 chromium: stands in for the Android WebView.
    {
      name: 'pixel-7',
      use: { ...devices['Pixel 7'] },
      testMatch: ADAPTIVE_SPECS,
    },
    // 834x1194 — above the 800px split floor but a touch device, so the
    // overlay drawer rather than a cramped split.
    {
      name: 'ipad-portrait',
      use: { ...devices['iPad Pro 11'] },
      testMatch: ADAPTIVE_SPECS,
    },
    // 1194x834 — expanded, so a real split-pane tablet experience.
    {
      name: 'ipad-landscape',
      use: { ...devices['iPad Pro 11 landscape'] },
      testMatch: ADAPTIVE_SPECS,
    },
  ],
  webServer: {
    // CI builds upstream packages as a separate step before e2e runs, so we
    // can skip the build here and start the dev server directly. Locally the
    // build keeps things self-contained so `npm run test:e2e` just works.
    // The burn-in (scripts/run-e2e-burn-in.ts) runs after the gate's own build
    // and sets DOCBLOCKS_E2E_PREBUILT to skip a second one.
    command:
      process.env.CI || process.env.DOCBLOCKS_E2E_PREBUILT
        ? 'npm run dev -w docblocks-site -- --strictPort'
        : 'npm run build && npm run dev -w docblocks-site -- --strictPort',
    url: 'http://localhost:5220',
    reuseExistingServer: !process.env.CI,
    // Locally the command builds every package first, which alone takes close
    // to three minutes; CI only starts the dev server.
    timeout: process.env.CI ? 180_000 : 360_000,
  },
});
