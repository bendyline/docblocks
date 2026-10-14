/**
 * The site suite's `test`, with the runtime-error invariant always on.
 *
 * Import from here rather than from `@playwright/test` so every spec inherits
 * the guard; a spec that imports the bare `test` opts itself out silently.
 *
 * A spec that provokes errors on purpose declares them per test:
 *
 *   test('...', async ({ page, allowRuntimeErrors }) => {
 *     allowRuntimeErrors({ reason: 'the test severs the network', match: /.../u });
 *   });
 */

import { test as base, expect } from '@playwright/test';
import {
  collectRuntimeErrors,
  formatRuntimeErrors,
  SHARED_ALLOWED_RUNTIME_ERRORS,
  unexpectedRuntimeErrors,
  type AllowedRuntimeError,
} from './console-guard.js';

interface RuntimeErrorFixtures {
  /** This test's allowance list; the guard reads it at teardown. */
  runtimeErrorAllowances: AllowedRuntimeError[];
  /** Allow further runtime errors for the current test only. */
  allowRuntimeErrors: (...allowances: readonly AllowedRuntimeError[]) => void;
  /** Auto fixture: installed for every test, asserted at teardown. */
  runtimeErrorGuard: void;
  /** Auto fixture: answers the download page's GitHub releases request locally. */
  githubReleasesStub: void;
}

const GITHUB_RELEASES_API =
  /^https:\/\/api\.github\.com\/repos\/bendyline\/docblocks\/releases(?:\?|$)/u;

export const test = base.extend<RuntimeErrorFixtures>({
  runtimeErrorAllowances: async ({ page: _page }, use) => {
    await use([...SHARED_ALLOWED_RUNTIME_ERRORS]);
  },

  allowRuntimeErrors: async ({ runtimeErrorAllowances }, use) => {
    await use((...allowances) => {
      runtimeErrorAllowances.push(...allowances);
    });
  },

  runtimeErrorGuard: [
    async ({ page, runtimeErrorAllowances }, use, testInfo) => {
      const readErrors = collectRuntimeErrors(page);

      await use();

      // A test that already failed reports its own cause; adding console noise
      // on top buries it. The guard only speaks when nothing else did.
      if (testInfo.errors.length > 0) return;
      const unexpected = unexpectedRuntimeErrors(readErrors(), runtimeErrorAllowances);
      if (unexpected.length === 0) return;
      throw new Error(formatRuntimeErrors(unexpected));
    },
    { auto: true },
  ],

  // /desktop/ asks the GitHub API for the latest release. CI runners share IPs,
  // so that unauthenticated request intermittently hits the rate limit (403),
  // and Chromium logs the failed load as a console error the guard rejects.
  // With no release the page falls back to its generic download links.
  githubReleasesStub: [
    async ({ context }, use) => {
      await context.route(GITHUB_RELEASES_API, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: '[]',
        }),
      );
      await use();
    },
    { auto: true },
  ],
});

export { expect };
