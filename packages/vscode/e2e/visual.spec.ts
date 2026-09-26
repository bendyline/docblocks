/**
 * Visual regression baselines for the DocBlocks webview inside VS Code.
 *
 * `theme-parity.spec.ts` proves the webview resolves the right `data-theme`
 * from the first painted frame. That is the hard part and worth its own test,
 * but it says nothing about whether the resulting surface is laid out — a
 * webview can carry `data-theme="light"` while its toolbar overflows or its
 * Monaco pane fails to size.
 *
 * Captures are scoped to `.db-shell` inside the webview frame rather than the
 * page: a page-level shot would include VS Code's own activity bar, tabs and
 * status bar, which change with the pinned VS Code build and have nothing to do
 * with DocBlocks.
 */

import type { Frame, FrameLocator, Page } from '@playwright/test';
import { expect, test } from './test.js';
import { expectStableScreenshot, waitForStableRender } from '../../../e2e/helpers/visual.js';

/**
 * Pin the webview chrome to the bundled face.
 *
 * The webview mounts Squisq's `EditorShell` rather than `DocBlocksShell`, so
 * nothing stamps the interface-font attribute for it. Stamping it from the test
 * keeps these baselines comparable across operating systems, exactly as the
 * site suite does through the stored preference.
 *
 * Re-applied on an interval because VS Code builds the webview's inner frame
 * with `document.open()`, which discards the element the attribute was set on —
 * the same reason `theme-parity.spec.ts` records with a timer rather than a
 * MutationObserver.
 */
const PIN_INTERFACE_FONT = () => {
  const stamp = () => {
    // `document.open()` leaves the document without a root element for a beat,
    // so this runs against null unless it checks. Throwing here would surface
    // as an uncaught page error and fail the test on the runtime-error guard
    // rather than on anything about the screenshot.
    const root = document.documentElement as HTMLElement | null;
    if (!root) return;
    if (root.getAttribute('data-db-interface-font') !== 'fixed') {
      root.setAttribute('data-db-interface-font', 'fixed');
    }
  };
  stamp();
  setInterval(stamp, 50);
};

async function waitForVSCode(page: Page): Promise<void> {
  await page.waitForSelector('.monaco-workbench', { timeout: 30_000 });
  await page.waitForSelector('.activitybar', { timeout: 15_000 });
}

async function selectColorTheme(page: Page, theme: string): Promise<void> {
  await page.keyboard.press('Control+K');
  await page.keyboard.press('Control+T');
  const quickInput = page.locator('.quick-input-widget');
  await expect(quickInput).toBeVisible({ timeout: 10_000 });
  await page.keyboard.type(theme);
  await expect(quickInput.getByText(theme, { exact: true }).first()).toBeVisible({
    timeout: 10_000,
  });
  await page.keyboard.press('Enter');
}

/**
 * Close VS Code's side bar so the webview's width is a function of the viewport
 * alone.
 *
 * The explorer's width is restored from workbench state, which changes the
 * webview's size and so the *dimensions* of every capture inside it — a
 * difference no pixel tolerance can reconcile, because the images are not the
 * same size.
 *
 * "Close", not "Toggle", and that distinction is the whole point: the workbench
 * persists its layout in the test runner's data directory, so a toggle leaves
 * the side bar open on the run after one that closed it. The captures then
 * alternate between two widths from one run to the next.
 */
async function closeSideBar(page: Page): Promise<void> {
  await page.keyboard.press('F1');
  const quickInput = page.locator('.quick-input-widget');
  await expect(quickInput).toBeVisible({ timeout: 10_000 });
  await page.keyboard.type('View: Close Primary Side Bar');
  await expect(quickInput.getByText('Close Primary Side Bar').first()).toBeVisible({
    timeout: 10_000,
  });
  await page.keyboard.press('Enter');
  await expect(quickInput).toBeHidden({ timeout: 10_000 });
}

/** Open the fixture, retrying the click that a theme re-render can swallow. */
async function openTestDoc(page: Page): Promise<void> {
  const testFile = page.locator('.explorer-folders-view').getByText('test-doc.md');
  await expect(testFile).toBeVisible({ timeout: 10_000 });
  await expect(async () => {
    await testFile.click();
    await expect(page.locator('iframe.webview')).not.toHaveCount(0, { timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
}

/** The webview's inner content frame, waited through at each hop. */
async function editorContent(page: Page): Promise<FrameLocator> {
  const webviews = page.locator('iframe.webview');
  await expect(webviews.last()).toBeVisible({ timeout: 15_000 });
  const activeFrame = webviews.last().contentFrame().locator('iframe#active-frame');
  await expect(activeFrame).toBeVisible({ timeout: 15_000 });
  return activeFrame.contentFrame();
}

/**
 * The real `Frame` behind the editor, for settling fonts.
 *
 * Found by asking each frame whether it contains the shell, rather than by
 * matching a URL: the webview's inner frame is built with `document.open()` and
 * its URL is not a reliable handle. Mirrors `findEditorFrame` in
 * `theme-parity.spec.ts`, which documents why evaluating against a frame that
 * is still navigating can hang rather than reject.
 */
async function editorFrame(page: Page): Promise<Frame> {
  let found: Frame | undefined;
  await expect
    .poll(
      async () => {
        for (const frame of page.frames()) {
          const hasShell = await frame
            .evaluate(() => Boolean(document.querySelector('.db-shell[data-theme]')))
            .catch(() => false);
          if (hasShell) {
            found = frame;
            return true;
          }
        }
        return false;
      },
      { timeout: 15_000, message: 'the DocBlocks editor shell never mounted in any frame' },
    )
    .toBe(true);
  return found as Frame;
}

test.describe('DocBlocks webview', () => {
  test.beforeEach(async ({ page }) => {
    // Installed before any webview frame exists so the very first painted frame
    // already carries the pinned chrome font.
    await page.addInitScript(PIN_INTERFACE_FONT);
    await page.goto('/');
    await waitForVSCode(page);
  });

  for (const { vscodeTheme, expected } of [
    { vscodeTheme: 'Light Modern', expected: 'light' },
    { vscodeTheme: 'Dark Modern', expected: 'dark' },
  ] as const) {
    test(`editor follows a ${expected} VS Code theme`, async ({ page }) => {
      await selectColorTheme(page, vscodeTheme);
      await openTestDoc(page);

      const content = await editorContent(page);
      const shell = content.locator('.db-shell[data-theme]');
      await expect(shell).toHaveAttribute('data-theme', expected, { timeout: 15_000 });
      await expect(content.locator('.squisq-toolbar')).toBeVisible({ timeout: 20_000 });

      await closeSideBar(page);
      const frame = await editorFrame(page);
      await frame.evaluate(() => document.fonts.ready.then(() => undefined));
      await waitForStableRender(shell);
      await expectStableScreenshot(page, shell, `webview-${expected}.png`);
    });
  }

  test('source mode renders Monaco against the VS Code theme', async ({ page }) => {
    await selectColorTheme(page, 'Dark Modern');
    await openTestDoc(page);

    const content = await editorContent(page);
    await expect(content.locator('.db-shell[data-theme]')).toHaveAttribute('data-theme', 'dark', {
      timeout: 15_000,
    });
    await closeSideBar(page);
    await content.locator('[role="tab"][data-view="raw"]').click();

    // Monaco applies its theme after mounting, so gate on the themed class
    // rather than on the container: capturing between the two bakes in a
    // light editor on a dark shell.
    const monaco = content.locator('.squisq-raw-editor-container .monaco-editor');
    await expect(monaco).toHaveClass(/vs-dark/u, { timeout: 20_000 });

    const frame = await editorFrame(page);
    await frame.evaluate(() => document.fonts.ready.then(() => undefined));
    // Monaco measures its container after mounting and settles a few pixels in
    // each direction, so two identical runs otherwise capture different image
    // dimensions — a difference no pixel tolerance can reconcile.
    await waitForStableRender(monaco);
    await expectStableScreenshot(page, monaco, 'webview-source-monaco-dark.png');
  });
});
