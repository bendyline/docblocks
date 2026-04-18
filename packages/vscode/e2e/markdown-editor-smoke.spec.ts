/**
 * Focused smoke test for the DocBlocks custom markdown editor.
 *
 * Goes beyond "the webview root is visible" — verifies that the React app
 * actually bootstraps, receives the document content from the extension,
 * and renders the editor surface with the fixture's markdown text.
 *
 * Also captures console errors and the screenshot path of a failed run.
 */

import { test, expect, type Page, type FrameLocator } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

async function waitForVSCode(page: Page) {
  await page.waitForSelector('.monaco-workbench', { timeout: 30_000 });
  await page.waitForSelector('.activitybar', { timeout: 15_000 });
}

async function getWebviewContent(page: Page): Promise<FrameLocator> {
  const webviews = page.locator('iframe.webview');
  const count = await webviews.count();
  const outerFrame = webviews.nth(count - 1).contentFrame();
  return outerFrame.locator('iframe#active-frame').contentFrame();
}

test.describe('DocBlocks markdown editor — full bootstrap', () => {
  const consoleErrors: string[] = [];
  const networkFailures: string[] = [];

  test.beforeEach(async ({ page }) => {
    consoleErrors.length = 0;
    networkFailures.length = 0;

    page.on('console', (msg) => {
      // Capture ALL types (error, warning, log) so we can diagnose missing content.
      consoleErrors.push(`[${msg.type()}] ${msg.text()}`);
    });
    page.on('pageerror', (err) => {
      consoleErrors.push(`[pageerror] ${err.message}\n${err.stack ?? ''}`);
    });
    page.on('response', (res) => {
      if (res.status() >= 400) networkFailures.push(`${res.status()} ${res.url()}`);
    });

    await page.goto('/');
    await waitForVSCode(page);
  });

  test('opens test-doc.md via Open With and renders fixture content', async ({ page }) => {
    // Locate file in explorer
    const explorer = page.locator('.explorer-folders-view');
    const testFile = explorer.getByText('test-doc.md');
    await expect(testFile).toBeVisible({ timeout: 10_000 });

    // Open With… → DocBlocks Editor
    await testFile.click();
    await page.waitForTimeout(300);
    await testFile.click({ button: 'right' });
    await page.waitForTimeout(800);

    const openWith = page
      .locator('.context-view .action-label')
      .filter({ hasText: 'Open With...' });
    await expect(openWith).toBeVisible({ timeout: 5_000 });
    await openWith.click();
    await page.waitForTimeout(500);

    const quickInput = page.locator('.quick-input-widget');
    await quickInput.getByText('DocBlocks Editor').click();
    await page.waitForTimeout(2_500);

    // Webview mount
    const webviews = page.locator('iframe.webview');
    await expect(webviews.last()).toBeVisible({ timeout: 15_000 });

    const content = await getWebviewContent(page);

    // The React root exists
    await expect(content.locator('#root')).toBeVisible({ timeout: 10_000 });

    // The root contains actual rendered content — not just an empty div.
    // Give the renderer a moment to hydrate + receive the 'setContent' IPC.
    await page.waitForTimeout(3_000);

    // Fail closed if the webview never loaded its JS/CSS — this was the
    // original regression (build order wiped dist/webview/).
    const assetFailures = networkFailures.filter((u) => u.includes('dist/webview/'));
    expect(
      assetFailures,
      `Webview assets returned 4xx — the extension shipped without its built renderer.\n` +
        assetFailures.join('\n'),
    ).toHaveLength(0);

    // The fixture text should appear somewhere in the rendered DOM.
    // squisq/tiptap renders the heading "Test Document" as an <h1> in the
    // wysiwyg surface. We look for the literal text, not a selector, so
    // the test doesn't over-specify squisq's internal markup.
    const rendered = await content.locator('body').innerText();

    // Guard against a class of regressions where the webview opens but the
    // bundle fails to execute (e.g. parse errors like
    // "Cannot use 'import.meta' outside a module", or missing dist assets
    // from a wiped build output).
    const pageErrors = consoleErrors.filter((m) => m.startsWith('[pageerror]'));
    expect(pageErrors, `Renderer threw:\n${pageErrors.join('\n')}`).toHaveLength(0);

    expect(
      rendered,
      `Webview rendered but no fixture content found. Console errors:\n${consoleErrors.join('\n')}`,
    ).toContain('Test Document');
  });

  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
      const screenshotPath = testInfo.outputPath('failure.png');
      await page.screenshot({ path: screenshotPath, fullPage: true });
      const diag = path.join(testInfo.outputDir, 'diagnostic.txt');
      fs.writeFileSync(
        diag,
        [
          `Network failures (${networkFailures.length}):`,
          ...networkFailures,
          '',
          `Console errors (${consoleErrors.length}):`,
          ...consoleErrors,
        ].join('\n'),
      );
    }
  });
});
