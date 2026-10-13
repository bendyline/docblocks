import { expect, test } from './helpers/test.js';
import { openInitializedSite } from './helpers/site.js';
import { exerciseDeferredMonaco, scanEditorControls } from './helpers/editor-regression.js';

for (const theme of ['Light', 'Dark']) {
  test(`integrated editor controls are accessible in ${theme}`, async ({ page }) => {
    await openInitializedSite(page);
    await page.getByRole('button', { name: 'DocBlocks', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByRole('radio', { name: theme, exact: true }).check();
    await settings.getByRole('button', { name: 'Close', exact: true }).click();
    await scanEditorControls(page);
  });
}

test('Monaco suggestions survive Source/Write transitions, rename, and reload', async ({
  page,
}) => {
  await openInitializedSite(page);
  const row = page.locator('.db-tree-row', { hasText: 'aboutDocBlocks' });
  await exerciseDeferredMonaco(page);
  await row.press('F2');
  const rename = page.locator('.db-tree-rename-input');
  await rename.fill('monaco-renamed.md');
  await rename.press('Enter');
  await expect(page.locator('.db-tree-row', { hasText: 'monaco-renamed' })).toBeVisible();
  await expect(page).toHaveURL(/monaco-renamed\.md$/);
  await page.reload();
  await expect(page.locator('.tiptap .monaco-editor')).toContainText('console.log(marker);');
  await exerciseDeferredMonaco(page);
});
