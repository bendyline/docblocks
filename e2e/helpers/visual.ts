/**
 * Shared plumbing for the visual regression suites.
 *
 * A screenshot assertion fails for two very different reasons: the UI changed,
 * or the capture was taken at a moment the UI had not settled. Only the first is
 * useful, so everything here exists to remove the second — the alternative is
 * raising `maxDiffPixelRatio` until the test stops failing, which also stops it
 * from working.
 *
 * The settle recipe is the one `e2e/live-ux-crawl.ts` arrived at for its
 * screenshot inventory: wait for webfonts, then let layout react to the swap.
 * Fonts are the one asset that changes a rendering after every element is
 * already visible.
 */

import { expect, type Locator, type Page } from '@playwright/test';

/*
 * Stabilisation is left to Playwright's own options rather than an injected
 * stylesheet. `animations: 'disabled'` freezes CSS animations and transitions
 * at their end state, and `caret: 'hide'` removes the blinking caret — which
 * together were all the custom sheet actually contributed.
 *
 * Injecting one also cost more than it gave: `stylePath` resolves through
 * `import.meta.url`, which breaks under the CommonJS transform the VS Code
 * suite runs, and the injected `<style>` is refused outright by the static
 * routes served under `style-src 'self'`, surfacing as a console error the
 * runtime-error guard then reports.
 */

/** Small settle for layout that reflows in response to the font swap. */
const FONT_SWAP_REFLOW_MS = 150;

/**
 * Wait for the page to stop changing for reasons unrelated to the state
 * under test. Safe to call on a page inside a webview frame.
 */
export async function settleForScreenshot(page: Page, extraSettleMs = 0): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined)).catch(() => undefined);
  await page.waitForTimeout(FONT_SWAP_REFLOW_MS + extraSettleMs);
}

/**
 * Wait until an element stops changing, in size and in content.
 *
 * Two distinct races produce baselines that differ between identical runs, and
 * both are settled here because a caller cannot usefully tell them apart:
 *
 * - **Size.** Some panes measure their container after mounting; Monaco settles
 *   a few pixels in each direction a frame or two after becoming visible. The
 *   images then differ in *dimensions*, which no pixel tolerance can reconcile.
 * - **Content.** A toolbar can gain a lazily-registered control after it first
 *   paints — the desktop editor header gains a Print button this way — and
 *   everything beside it shifts. The image is the same size and almost entirely
 *   different.
 *
 * Settling on both is what makes a failure mean "the UI changed" rather than
 * "the capture was early".
 */
export async function waitForStableRender(target: Locator, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let previous = '';
  let stableReadings = 0;

  while (Date.now() < deadline) {
    const box = await target.boundingBox();
    // Child count and text stand in for content: cheap to read, and they move
    // for exactly the cases above without being sensitive to attribute churn.
    const content = await target
      .evaluate((element) => `${element.childElementCount}:${element.textContent?.length ?? 0}`)
      .catch(() => 'none');
    const current = box ? `${Math.round(box.width)}x${Math.round(box.height)}:${content}` : 'none';

    stableReadings = current === previous ? stableReadings + 1 : 0;
    previous = current;
    // Two consecutive equal readings: enough to clear a reflow or a late
    // registration, short enough not to mask a genuinely churning surface.
    if (stableReadings >= 2 && current !== 'none') return;
    await target.page().waitForTimeout(100);
  }

  throw new Error(
    `The element never settled within ${timeoutMs}ms (last: ${previous}). ` +
      'Capturing it would produce a baseline that differs between identical runs.',
  );
}

export interface StableScreenshotOptions {
  /** Regions whose content is environment-dependent (paths, versions, results). */
  readonly mask?: readonly Locator[];
  /** Extra milliseconds to settle, for a surface with a known slow transition. */
  readonly settleMs?: number;
  /**
   * Only for a capture with genuinely non-deterministic pixels, with the reason
   * given at the call site. Prefer masking the region instead — a ratio applies
   * to the whole image and will hide a real change somewhere else in it.
   */
  readonly maxDiffPixelRatio?: number;
  /** Clip, in page coordinates. Use to capture a seam rather than a window. */
  readonly clip?: { x: number; y: number; width: number; height: number };
}

/**
 * Assert a target matches its committed baseline.
 *
 * Prefer passing an element rather than a page: a smaller capture has less
 * surface to drift, produces a far smaller committed PNG, and names what the
 * assertion is actually about.
 */
export async function expectStableScreenshot(
  page: Page,
  target: Locator | Page,
  name: string,
  options: StableScreenshotOptions = {},
): Promise<void> {
  await settleForScreenshot(page, options.settleMs ?? 0);
  await expect(target).toHaveScreenshot(name, {
    animations: 'disabled',
    caret: 'hide',
    ...(options.mask ? { mask: [...options.mask] } : {}),
    ...(options.maxDiffPixelRatio === undefined
      ? {}
      : { maxDiffPixelRatio: options.maxDiffPixelRatio }),
    ...(options.clip ? { clip: options.clip } : {}),
  });
}

/**
 * Name a baseline that is captured separately on each operating system.
 *
 * Shared shell states use one Linux baseline, because the shell chrome resolves
 * `system-ui` to a different typeface per platform. Native chrome — window
 * controls, title bars, platform dialogs — has no shared rendering to compare,
 * so those baselines are per platform by name.
 */
export function platformBaseline(name: string): string {
  return `${name}-${process.platform}.png`;
}
