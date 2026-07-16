import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';
import path from 'path';
import { vscodeWebUrl } from './web-test-settings.js';

export function createVscodeWebE2EConfig(isCI: boolean): PlaywrightTestConfig {
  return {
    testDir: '.',
    globalSetup: path.resolve(__dirname, 'global-setup.ts'),
    fullyParallel: false,
    forbidOnly: isCI,
    retries: isCI ? 2 : 0,
    workers: 1,
    reporter: isCI ? 'github' : [['list'], ['html', { open: 'never' }]],
    timeout: 60_000,
    use: {
      baseURL: vscodeWebUrl,
      trace: 'on-first-retry',
      actionTimeout: 15_000,
    },
    projects: [
      {
        name: 'chromium',
        use: { ...devices['Desktop Chrome'] },
      },
    ],
  };
}

export default defineConfig(createVscodeWebE2EConfig(Boolean(process.env.CI)));
