import { defineConfig } from '@playwright/test';

/**
 * Playwright config for the DocBlocks Electron app e2e suite.
 *
 * Electron cannot be parallelised (single shared OS app bundle), so we
 * run workers=1 and disable fullyParallel. Startup on CI runners can be
 * slow on the first run, hence the generous timeouts.
 */
export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'html',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    actionTimeout: 15_000,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'electron',
      testMatch: /.*\.spec\.ts/,
    },
  ],
});
