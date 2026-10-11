import { expect, test } from './helpers/test.js';
import { openInitializedSite } from './helpers/site.js';

test('Ctrl/Cmd+Shift+F finds saved text and opens the match beside the results', async ({
  page,
}) => {
  await openInitializedSite(page);
  await page.getByRole('button', { name: 'New File', exact: true }).click();
  await page.getByRole('textbox', { name: 'New file name' }).fill('search-target.md');
  await page.getByRole('textbox', { name: 'New file name' }).press('Enter');
  const editor = page.locator('.ProseMirror[contenteditable="true"]');
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await page.keyboard.insertText('A Zebracorn lantern glows here.');

  // Move away so the next open is a real navigation, then search.
  await page.locator('.db-tree-row', { hasText: 'aboutDocBlocks' }).click();
  await expect(page).toHaveTitle(/aboutDocBlocks/u);
  await page.keyboard.press('ControlOrMeta+Shift+f');

  const input = page.getByRole('searchbox', { name: 'Search workspace' });
  await expect(input).toBeFocused();
  await expect(page.locator('.db-file-explorer')).toBeHidden();
  await input.fill('zebracorn');

  const results = page.getByRole('tree', { name: 'Search results' });
  const document = results.locator('.db-search-document', { hasText: 'search-target' });
  await expect(document).toBeVisible({ timeout: 15_000 });
  await expect(results.locator('.db-search-line mark').first()).toHaveText('Zebracorn');

  // Match case: the lowercase query no longer matches.
  await page.getByRole('button', { name: 'Match case' }).click();
  await expect(page.locator('.db-search-status')).toContainText('No results', { timeout: 5_000 });
  await page.getByRole('button', { name: 'Match case' }).click();
  await expect(document).toBeVisible({ timeout: 5_000 });

  await results.locator('.db-search-line').first().click();
  await expect(page).toHaveTitle('search-target - DocBlocks');
  await expect(input).toBeVisible();
  await expect(input).toHaveValue('zebracorn');

  // Back to Files; the tree is exactly as it was.
  await page.getByRole('button', { name: 'Show files' }).click();
  await expect(page.locator('.db-file-explorer')).toBeVisible();
  await expect(input).toBeHidden();
});
