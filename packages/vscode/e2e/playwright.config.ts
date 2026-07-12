import { defineConfig, devices } from '@playwright/test';
import path from 'path';

const extensionPath = path.resolve(__dirname, '..');
const fixturesPath = path.resolve(extensionPath, 'test-fixtures');
// Keep the E2E runtime reproducible and let @vscode/test-web reuse its local
// cache without first reaching the mutable "latest insiders" endpoint.
const vscodeWebCommit =
  process.env.VSCODE_TEST_WEB_COMMIT ?? 'e8a3eada3426fa6848c7494ebe2291702fef4a61';

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'html',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:3100',
    trace: 'on-first-retry',
    actionTimeout: 15_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `npx vscode-test-web --quality=insiders --commit=${vscodeWebCommit} --extensionDevelopmentPath=${extensionPath} --browser=none --port=3100 --headless ${fixturesPath}`,
    url: 'http://localhost:3100',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
