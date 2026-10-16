import { expect, test } from './helpers/test.js';
import { openInitializedSite } from './helpers/site.js';

test('F1, ? and the app menu open the keyboard shortcut sheet', async ({ page }) => {
  await openInitializedSite(page);
  await page.getByRole('button', { name: 'New File', exact: true }).click();
  await page.getByRole('textbox', { name: 'New file name' }).fill('shortcut-notes.md');
  await page.getByRole('textbox', { name: 'New file name' }).press('Enter');
  await expect(page).toHaveTitle('shortcut-notes - DocBlocks', { timeout: 15_000 });
  const editor = page.locator('.ProseMirror[contenteditable="true"]');
  await expect(editor).toBeVisible({ timeout: 15_000 });
  const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });

  // F1 works mid-sentence.
  await editor.click();
  await page.keyboard.press('F1');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('region', { name: 'Documents and files' })).toContainText(
    'Go to document',
  );
  // A browser tab keeps Ctrl+N for itself, so the web sheet does not offer it.
  await expect(sheet).not.toContainText('New document');
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);

  // `?` is text while writing, and opens the sheet anywhere else.
  await editor.press('End');
  await page.keyboard.type('?');
  await expect(sheet).toHaveCount(0);
  await page.locator('.db-tree-row').first().focus();
  await page.keyboard.press('Shift+?');
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');

  await page.locator('.db-app-menu-btn').click();
  await page.getByRole('menuitem', { name: 'Keyboard shortcuts' }).click();
  await expect(sheet).toBeVisible();
});
