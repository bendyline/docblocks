import { defineConfig, devices } from '@playwright/test';
import { createRequire } from 'node:module';
import path from 'path';

const extensionPath = path.resolve(__dirname, '..');
const fixturesPath = path.resolve(extensionPath, 'test-fixtures');
const require = createRequire(__filename);
const testWebCli = require.resolve('@vscode/test-web/out/server/index.js');
const quoteCommandArgument = (value: string): string => `"${value.replaceAll('"', '\\"')}"`;
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
  reporter: process.env.CI ? 'github' : [['html', { open: 'never' }]],
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
    // Launch the actual Node CLI. On Windows an intermediate npx/cmd process
    // does not reliably forward Playwright's termination signal, leaving the
    // test runner hung after its browser and assertions have already closed.
    command: `${quoteCommandArgument(process.execPath)} ${quoteCommandArgument(testWebCli)} --quality=insiders --commit=${vscodeWebCommit} --extensionDevelopmentPath=${quoteCommandArgument(extensionPath)} --browser=none --port=3100 --headless ${quoteCommandArgument(fixturesPath)}`,
    url: 'http://localhost:3100',
    // The extension host serves mutable build output and fixture files. Reusing
    // an orphaned local process can test stale code and, on Windows, leave a
    // large child-process tree behind after a timed-out run. Every canonical
    // invocation owns and tears down the server it validates.
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
