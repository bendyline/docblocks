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
}

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
});

export { expect };
