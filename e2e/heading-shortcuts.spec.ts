import { expect, test } from './helpers/test.js';
import { viewButton } from './helpers/toolbar.js';
import { openInitializedSite } from './helpers/site.js';

test('toggles H1 through H6 without switching editor views', async ({ page }) => {
  await openInitializedSite(page);
  await page.getByRole('button', { name: 'New File', exact: true }).click();
  await page.getByRole('textbox', { name: 'New file name' }).fill('heading-shortcuts.md');
  await page.getByRole('textbox', { name: 'New file name' }).press('Enter');
  // The welcome document's editor is in Write too until this one replaces it.
  const editor = page.getByRole('textbox', { name: /^Edit \/?heading-shortcuts\.md$/ });
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await page.keyboard.insertText('Shortcut heading');

  for (const level of [1, 2, 3, 4, 5, 6]) {
    await page.keyboard.press(`ControlOrMeta+${level}`);
    await expect(editor.locator(`h${level}`)).toContainText('Shortcut heading');
    await expect(viewButton(page)).toHaveAttribute('data-active-view', 'wysiwyg');
    await page.keyboard.press(`ControlOrMeta+${level}`);
    await expect(editor.locator('p')).toHaveText('Shortcut heading');
    await expect(editor.locator('h1, h2, h3, h4, h5, h6')).toHaveCount(0);
  }

  await page.keyboard.press('ControlOrMeta+6');
  await page.keyboard.press('ControlOrMeta+Shift+2');
  await expect(viewButton(page)).toHaveAttribute('data-active-view', 'raw');
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('###### Shortcut heading');
  await page.locator('.monaco-editor textarea').press('ControlOrMeta+Shift+3');
  await expect(viewButton(page)).toHaveAttribute('data-active-view', 'preview');
  await viewButton(page).press('ControlOrMeta+Shift+1');
  await expect(editor.locator('h6')).toContainText('Shortcut heading');
});
