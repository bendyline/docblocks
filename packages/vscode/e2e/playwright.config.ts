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
        testIgnore: /visual\.spec\.ts/,
      },
      // Visual regression: a pre-release gate rather than part of the default
      // run. Declared only under the visual runner — `npx playwright test` with
      // no `--project` runs every declared project, so an always-present visual
      // project would land a pixel comparison inside `npm run test:e2e:vscode`
      // and so inside the canonical gate. See the repo-root config for the rest
      // of the reasoning.
      ...(process.env.DOCBLOCKS_VISUAL === '1'
        ? [
            {
              name: 'visual',
              use: { ...devices['Desktop Chrome'] },
              testMatch: /visual\.spec\.ts/u,
              // Baselines are captured on Linux; elsewhere the spec still runs,
              // so a broken selector or a webview that never mounts still
              // fails, but the pixels are not compared.
              ignoreSnapshots: !(
                process.platform === 'linux' || process.env.DOCBLOCKS_VISUAL_COMPARE === '1'
              ),
              // A retried screenshot that passes on the second attempt hides a
              // real diff, so this project never retries even though the suite
              // does.
              retries: 0,
            },
          ]
        : []),
    ],
    snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{arg}{ext}',
  };
}

export default defineConfig(createVscodeWebE2EConfig(Boolean(process.env.CI)));
