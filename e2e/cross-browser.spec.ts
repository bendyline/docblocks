import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openInitializedSite } from './helpers/site.js';

test('boots the editor and exports Markdown', async ({ page }) => {
  await openInitializedSite(page);
  await expect(page.locator('.db-shell')).toBeVisible();
  await expect(page.locator('main.db-shell-editor-area')).toContainText(
    'DocBlocks: one Markdown file, many finished forms',
  );

  await page.getByRole('button', { name: 'Export and share' }).click();
  await page.getByRole('menuitem', { name: 'Export...' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export Document' });
  await dialog.getByRole('radio', { name: 'Markdown' }).click();
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Save MD to Downloads', exact: true }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error('Cross-browser export did not produce a file');

  expect(download.suggestedFilename()).toBe('aboutDocBlocks.md');
  expect(await readFile(downloadPath, 'utf8')).toContain(
    '# DocBlocks: one Markdown file, many finished forms',
  );
});
