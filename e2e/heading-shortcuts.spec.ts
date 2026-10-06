import { expect, test } from './helpers/test.js';
import { openInitializedSite } from './helpers/site.js';

test('toggles H1 through H6 without switching editor views', async ({ page }) => {
  await openInitializedSite(page);
  await page.getByRole('button', { name: 'New File', exact: true }).click();
  await page.getByRole('textbox', { name: 'New file name' }).fill('heading-shortcuts.md');
  await page.getByRole('textbox', { name: 'New file name' }).press('Enter');
  const editor = page.locator('.ProseMirror[contenteditable="true"]');
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await page.keyboard.insertText('Shortcut heading');

  for (const level of [1, 2, 3, 4, 5, 6]) {
    await page.keyboard.press(`ControlOrMeta+${level}`);
    await expect(editor.locator(`h${level}`)).toContainText('Shortcut heading');
    await expect(page.locator('[data-view="wysiwyg"]')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press(`ControlOrMeta+${level}`);
    await expect(editor.locator('p')).toHaveText('Shortcut heading');
    await expect(editor.locator('h1, h2, h3, h4, h5, h6')).toHaveCount(0);
  }

  await page.keyboard.press('ControlOrMeta+6');
  await page.keyboard.press('ControlOrMeta+Shift+2');
  await expect(page.locator('[data-view="raw"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('###### Shortcut heading');
  await page.locator('.monaco-editor textarea').press('ControlOrMeta+Shift+3');
  await expect(page.locator('[data-view="preview"]')).toHaveAttribute('aria-selected', 'true');
  await page.locator('[data-view="preview"]').press('ControlOrMeta+Shift+1');
  await expect(editor.locator('h6')).toContainText('Shortcut heading');
});
