import type { Page } from '@playwright/test';
import { MONACO_COLD_LOAD_TIMEOUT } from './helpers/editor-regression.js';
import { openInitializedSite } from './helpers/site.js';
import { expect, test } from './helpers/test.js';
import { showSourceView } from './helpers/toolbar.js';
import { createDocument } from './helpers/new-document.js';

/**
 * A Web page whose page template is missing still saves its Markdown, and the
 * shell says the page itself is not updating: on the save that hits the
 * problem, and again whenever the page is reopened before it is fixed.
 */

function treeRow(page: Page, path: string) {
  return page.locator(`.db-tree-row[data-path="${path}"], .db-tree-row[data-path="/${path}"]`);
}

/**
 * The tree row can appear before the page's own editor mounts, and that mount
 * starts in Write. Clicking Source earlier switches the outgoing document's
 * editor instead, so wait for this page's editor first.
 */
async function openPageSource(page: Page) {
  // Named in the title field, so its companion keeps the name it was created under.
  await expect(page.getByRole('textbox', { name: /^Edit \/?hello_files\/[^/]+\.md$/ })).toBeVisible(
    {
      timeout: 30_000,
    },
  );
  await showSourceView(page);
}

test('saves the Markdown and warns when a Web page names a missing page template', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openInitializedSite(page);

  await createDocument(page, 'hello.html', { type: 'Static web page' });
  await expect(treeRow(page, 'hello.html')).toBeVisible({ timeout: 30_000 });

  await openPageSource(page);
  const lines = page.locator('.monaco-editor .view-lines');
  await lines.click({ timeout: MONACO_COLD_LOAD_TIMEOUT });
  // Monaco picks shortcuts from the user agent, not the test host.
  const documentStart = await page
    .locator('.monaco-editor textarea')
    .evaluate(() => (navigator.userAgent.includes('Macintosh') ? 'Meta+ArrowUp' : 'Control+Home'));
  await page.keyboard.press(documentStart);
  await page.keyboard.press('End');
  await page.keyboard.insertText('\nsquisq-output-template: /missing.html');

  const banner = page.locator('.db-page-template-banner');
  await expect(banner).toContainText('was not found', { timeout: 15_000 });
  await expect(banner).toContainText('Your Markdown is saved');
  await expect(page.locator('.db-save-toast--error')).toHaveCount(0);
  // Another document never shows this page's warning; reopening the page
  // shows it again, and its saved Markdown still names the template.
  await treeRow(page, 'Welcome.md').click();
  await expect(banner).toHaveCount(0);
  await treeRow(page, 'hello.html').click();
  await expect(banner).toContainText('was not found', { timeout: 15_000 });
  await openPageSource(page);
  await expect(lines).toContainText('squisq-output-template: /missing.html', {
    timeout: MONACO_COLD_LOAD_TIMEOUT,
  });

  // Dismiss holds while autosave keeps reporting the same problem.
  await banner.getByRole('button', { name: 'Dismiss' }).click();
  await expect(banner).toHaveCount(0);
  await lines.click();
  await page.keyboard.press(documentStart);
  await page.keyboard.press('End');
  await page.keyboard.insertText('\ndescription: still typing');
  await expect(lines).toContainText('description: still typing');
  await page.waitForTimeout(2_000);
  await expect(banner).toHaveCount(0);
});
