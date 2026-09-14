import { defineConfig, devices } from '@playwright/test';

/** Specs that run on the touch-emulating device projects instead of chromium. */
const ADAPTIVE_SPECS = /adaptive-.*\.spec\.ts/;

/**
 * Visual regression specs. They live in their own projects because they are a
 * pre-release gate rather than part of `npm run all`: a pixel baseline is only
 * meaningful on the platform that captured it, and a screenshot diff should not
 * block a PR that changed nothing visible. Run them with
 * `npm run test:e2e:visual`.
 */
const VISUAL_SHELL_SPECS = /visual\.spec\.ts/;
const VISUAL_ADAPTIVE_SPECS = /visual-adaptive\.spec\.ts/;

/**
 * The shell chrome resolves `system-ui` to a different typeface on each
 * operating system, so one committed baseline cannot match everywhere. Linux is
 * where CI captures and compares; elsewhere the specs still run — catching
 * crashes, timeouts and broken selectors — but the pixels are not compared.
 *
 * `DOCBLOCKS_VISUAL_COMPARE=1` turns comparison on anyway, for iterating on the
 * suite from a developer machine. It will report differences that are only the
 * platform's font rasterisation, so treat its failures as local noise unless
 * the change is plainly structural.
 */
const COMPARES_SHARED_BASELINES =
  process.platform === 'linux' || process.env.DOCBLOCKS_VISUAL_COMPARE === '1';

/**
 * Suites with their own config: offline needs a production preview server and
 * cross-browser drives firefox/webkit.
 */
const ROOT_TEST_IGNORE = ['**/offline.spec.ts', '**/cross-browser.spec.ts'];

const DEFAULT_TEST_IGNORE = [
  ...ROOT_TEST_IGNORE,
  '**/visual.spec.ts',
  '**/visual-adaptive.spec.ts',
];

/**
 * Whether the visual projects exist at all for this run.
 *
 * `npx playwright test` with no `--project` runs EVERY project, and a project's
 * own `testIgnore` REPLACES the top-level one — so a visual project can never
 * be excluded by ignore lists alone without also excluding it from its own run.
 * Declaring the projects only when the visual runner asks for them is what
 * keeps a pixel comparison out of `npm run all`, the one place it must not be.
 *
 * `scripts/run-visual-tests.ts` sets this; `check:assurance` fails if the
 * visual suite ever reaches the canonical gate.
 */
const INCLUDE_VISUAL_PROJECTS = process.env.DOCBLOCKS_VISUAL === '1';

export default defineConfig({
  testDir: './e2e',
  // The offline/PWA spec needs a production build (the service worker never
  // registers on the dev server this config starts) — it runs from
  // playwright.offline.config.ts via `npm run test:e2e:offline`.
  testIgnore: DEFAULT_TEST_IGNORE,
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
  // Keep every project's baselines apart: the same state captured at phone and
  // tablet sizes is two different images.
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{arg}{ext}',
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
      // they silently start running on this project. The visual specs are
      // excluded here rather than at the top level for the mirror-image
      // reason: a top-level ignore would also hide them from the visual
      // projects below, which is how they end up matching nothing at all.
      testIgnore: [...DEFAULT_TEST_IGNORE, ADAPTIVE_SPECS],
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
    ...(INCLUDE_VISUAL_PROJECTS
      ? [
          // Visual regression. Present only under the visual runner, and repeating the
          // device definitions above rather than reusing those projects, because each
          // needs its own baseline directory and snapshot policy.
          {
            name: 'visual',
            use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
            testMatch: VISUAL_SHELL_SPECS,
            // Replaces DEFAULT_TEST_IGNORE, which excludes this spec.
            testIgnore: ROOT_TEST_IGNORE,
            ignoreSnapshots: !COMPARES_SHARED_BASELINES,
          },
          {
            name: 'visual-phone',
            use: { ...devices['iPhone 13'] },
            testMatch: VISUAL_ADAPTIVE_SPECS,
            testIgnore: ROOT_TEST_IGNORE,
            ignoreSnapshots: !COMPARES_SHARED_BASELINES,
          },
          {
            name: 'visual-tablet-portrait',
            use: { ...devices['iPad Pro 11'] },
            testMatch: VISUAL_ADAPTIVE_SPECS,
            testIgnore: ROOT_TEST_IGNORE,
            ignoreSnapshots: !COMPARES_SHARED_BASELINES,
          },
          {
            name: 'visual-tablet-landscape',
            use: { ...devices['iPad Pro 11 landscape'] },
            testMatch: VISUAL_ADAPTIVE_SPECS,
            testIgnore: ROOT_TEST_IGNORE,
            ignoreSnapshots: !COMPARES_SHARED_BASELINES,
          },
        ]
      : []),
  ],
  webServer: {
    // CI builds upstream packages as a separate step before e2e runs, so we
    // can skip the build here and start the dev server directly. Locally the
    // build keeps things self-contained so `npm run test:e2e` just works.
    command: process.env.CI
      ? 'npm run dev -w docblocks-site -- --strictPort'
      : 'npm run build && npm run dev -w docblocks-site -- --strictPort',
    url: 'http://localhost:5220',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
