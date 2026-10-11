import { expect, test } from './helpers/test.js';
import { openInitializedSite } from './helpers/site.js';

async function createDocument(page: import('@playwright/test').Page, name: string) {
  await page.getByRole('button', { name: 'New File', exact: true }).click();
  await page.getByRole('textbox', { name: 'New file name' }).fill(name);
  await page.getByRole('textbox', { name: 'New file name' }).press('Enter');
  await expect(page).toHaveTitle(`${name.replace(/\.md$/u, '')} - DocBlocks`, { timeout: 15_000 });
}

test('Ctrl/Cmd+P jumps to a document by name and remembers recent ones', async ({ page }) => {
  await openInitializedSite(page);
  await createDocument(page, 'quick-alpha.md');
  await createDocument(page, 'quick-beta.md');

  const editor = page.locator('.ProseMirror[contenteditable="true"]');
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+p');

  const dialog = page.getByRole('dialog', { name: 'Go to document' });
  const input = dialog.getByRole('combobox', { name: 'Go to document' });
  await expect(input).toBeFocused();
  await input.fill('quick-alp');
  await expect(dialog.getByRole('option').first()).toContainText('quick-alpha');
  await input.press('Enter');

  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveTitle('quick-alpha - DocBlocks');
  await expect(page.locator('.db-tree-row--selected')).toContainText('quick-alpha');

  // An empty query lists recently opened documents, skipping the open one.
  await editor.click();
  await page.keyboard.press('ControlOrMeta+p');
  await expect(dialog.getByRole('option').first()).toContainText('quick-beta');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
