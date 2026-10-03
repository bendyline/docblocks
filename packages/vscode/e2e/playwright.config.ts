import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';
import path from 'path';
import { vscodeWebUrl } from './web-test-settings.js';
import {
  DETERMINISTIC_TEXT_ARGS,
  comparesBaselines,
  visualProjectsEnabled,
} from '../../../e2e/helpers/visual-platform.js';

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
      ...(visualProjectsEnabled()
        ? [
            {
              name: 'visual',
              use: {
                ...devices['Desktop Chrome'],
                launchOptions: { args: [...DETERMINISTIC_TEXT_ARGS] },
              },
              testMatch: /visual\.spec\.ts/u,
              // Pixels compare only on the platform the baselines were
              // captured on; elsewhere the spec still runs, so a broken
              // selector or a webview that never mounts still fails.
              ignoreSnapshots: !comparesBaselines(),
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
