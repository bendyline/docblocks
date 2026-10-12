import { expect, test } from './helpers/test.js';
import { openInitializedSite } from './helpers/site.js';

test('Ctrl/Cmd+F opens one find bar in Write and Source', async ({ page }) => {
  await openInitializedSite(page);
  await page.getByRole('button', { name: 'New File', exact: true }).click();
  await page.getByRole('textbox', { name: 'New file name' }).fill('find-shortcut.md');
  await page.getByRole('textbox', { name: 'New file name' }).press('Enter');
  const editor = page.locator('.ProseMirror[contenteditable="true"]');
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await page.keyboard.insertText('alpha beta alpha gamma alpha');

  const findInput = page.getByRole('searchbox', { name: 'Find in document' });
  const findButton = page.getByRole('button', { name: 'Find in document' });

  // Write: the shortcut opens the bar from inside the document and focuses it.
  await page.keyboard.press('ControlOrMeta+f');
  await expect(findInput).toBeFocused();
  await expect(findButton).toHaveAttribute('aria-pressed', 'true');
  await findInput.fill('alpha');
  await expect(page.locator('.squisq-find-count')).toContainText('3');
  await findInput.press('Escape');
  await expect(findInput).toHaveCount(0);

  // Source: the same bar, not Monaco's built-in find widget.
  await editor.click();
  await page.keyboard.press('ControlOrMeta+Shift+2');
  await expect(page.locator('[data-view="raw"]')).toHaveAttribute('aria-selected', 'true');
  await page.locator('.monaco-editor textarea').press('ControlOrMeta+f');
  await expect(findInput).toBeFocused();
  await expect(page.locator('.monaco-editor .find-widget.visible')).toHaveCount(0);

  // A second press while open returns the caret to the query.
  await findInput.fill('gamma');
  await page.locator('.monaco-editor textarea').focus();
  await page.keyboard.press('ControlOrMeta+f');
  await expect(findInput).toBeFocused();
  await expect(findInput).toHaveValue('gamma');
});
