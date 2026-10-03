/**
 * The VS Code Web suite's `test`, with the runtime-error invariant always on.
 *
 * Import from here rather than from `@playwright/test` so every spec inherits
 * the guard; a spec that imports the bare `test` opts itself out silently.
 *
 * This suite drives a whole second application: the page is VS Code's
 * workbench, and our editor is a nested iframe inside it. Workbench noise that
 * DocBlocks cannot fix is allowed below, with the reason recorded; anything
 * from our own webview should be fixed rather than allowed.
 */

import { test as base, expect } from '@playwright/test';
import {
  collectRuntimeErrors,
  formatRuntimeErrors,
  SHARED_ALLOWED_RUNTIME_ERRORS,
  unexpectedRuntimeErrors,
  type AllowedRuntimeError,
} from '../../../e2e/helpers/console-guard.js';

/**
 * Workbench- and harness-owned messages. Keep each one anchored and justified:
 * anything originating in the DocBlocks webview belongs in a fix, not here.
 * The `data:` font this suite used to report was one of those — the webview CSP
 * omitted `data:` from `font-src` while the site and desktop allowed it, so the
 * bundled icon face was blocked. See packages/vscode/test/webview-csp.test.ts.
 */
export const VSCODE_ALLOWED_RUNTIME_ERRORS: readonly AllowedRuntimeError[] = [
  ...SHARED_ALLOWED_RUNTIME_ERRORS,
  {
    // @vscode/test-web serves the extension from /static/devextensions and
    // probes for a localization bundle. DocBlocks ships no translations, so
    // the probe 404s in the harness and nowhere else.
    reason: 'harness: @vscode/test-web probes for an nls bundle the extension does not ship',
    match: /Failed to load resource/u,
    location: /\/static\/devextensions\/package\.nls\.json/u,
  },
  {
    // The workbench asks the marketplace about the extension it is hosting.
    // A development extension under test has never been published, so the
    // gallery answers 404.
    reason: 'workbench: marketplace lookup for the unpublished development extension',
    match: /Failed to load resource/u,
    location: /marketplace\.visualstudio\.com\/_apis\/public\/gallery/u,
  },
  {
    // A built-in extension of the pinned VS Code Web build using an API
    // proposal that build does not enable. Neither the extension nor the
    // version is ours.
    reason: "workbench: VS Code's own bundled extension against a pinned insiders build",
    match: /Extension '[^']+' CANNOT use '[^']+' without the '[^']+' API proposal enabled/u,
  },
  {
    // Same bundled extension, racing its own language-model tool registration
    // during activation; it appears in roughly one run in thirty. DocBlocks
    // contributes no `languageModelTools`, so no message of this shape can be
    // about a DocBlocks contribution.
    reason: 'workbench: a bundled extension races its own language-model tool registration',
    match: /Tool "[^"]+" was not contributed/u,
  },
];

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
    await use([...VSCODE_ALLOWED_RUNTIME_ERRORS]);
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
