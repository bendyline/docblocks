import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'cross-browser.spec.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['html', { open: 'never', outputFolder: 'playwright-report-cross-browser' }]],
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5220',
    trace: 'on-first-retry',
  },
  projects: [
    // Playwright 1.58's Firefox driver currently fails before page creation on
    // Windows. Keep Firefox in Linux/macOS CI while retaining WebKit locally.
    ...(process.platform === 'win32'
      ? []
      : [{ name: 'firefox', use: { ...devices['Desktop Firefox'] } }]),
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: process.env.CI
      ? 'npm run dev -w docblocks-site -- --strictPort'
      : 'npm run build && npm run dev -w docblocks-site -- --strictPort',
    url: 'http://localhost:5220',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
