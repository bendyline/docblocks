import { defineConfig } from '@playwright/test';

/**
 * Smoke the electron-builder output, not the source Electron entry point.
 * The fixture uses renderer CDP because production fuses correctly disable
 * the Node inspector required by Playwright's `_electron.launch()` API.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /packaged-smoke\.spec\.ts/u,
  outputDir: 'test-results/packaged',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? 'github'
    : [['html', { outputFolder: 'playwright-report/packaged', open: 'never' }]],
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    actionTimeout: 15_000,
  },
  projects: [
    {
      name: 'electron-packaged',
    },
  ],
});
