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

import { writeFile } from 'node:fs/promises';
import { test as base, expect, type TestInfo } from '@playwright/test';
import {
  collectRuntimeErrors,
  describeNetworkChange,
  formatRuntimeErrors,
  SHARED_ALLOWED_RUNTIME_ERRORS,
  unexpectedRuntimeErrors,
  type AllowedRuntimeError,
  type RuntimeError,
} from './console-guard.js';

/**
 * The failure message keeps one line per error. Keep each one whole, stack
 * included, since an allowance has to match all of it. A file (not a body) so
 * list reporters print its path and CI uploads it.
 */
async function attachRuntimeErrors(
  testInfo: TestInfo,
  errors: readonly RuntimeError[],
): Promise<void> {
  const report = testInfo.outputPath('runtime-errors.json');
  await writeFile(report, `${JSON.stringify(errors, null, 2)}\n`);
  await testInfo.attach('runtime-errors.json', { path: report, contentType: 'application/json' });
}

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
      // on top buries it. The guard only speaks when nothing else did, or
      // when the cause was a network change the assertion cannot name. It
      // still files every error the page raised, allowed ones included: an
      // engine trap the allowances excuse in a passing test is what explains
      // a squiggle or a preview that never came.
      if (testInfo.errors.length > 0) {
        const errors = readErrors();
        if (errors.length > 0) await attachRuntimeErrors(testInfo, errors);
        const networkChange = describeNetworkChange(errors);
        if (networkChange !== undefined) throw new Error(networkChange);
        return;
      }
      const unexpected = unexpectedRuntimeErrors(readErrors(), runtimeErrorAllowances);
      if (unexpected.length === 0) return;
      await attachRuntimeErrors(testInfo, unexpected);
      throw new Error(formatRuntimeErrors(unexpected));
    },
    { auto: true },
  ],
});

export { expect };
