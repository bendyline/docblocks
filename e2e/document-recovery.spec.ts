import { expect, test } from './helpers/test.js';
import { openInitializedSite } from './helpers/site.js';

test('compares a recovered draft with the saved file and remembers the choice after restart', async ({
  page,
}) => {
  await openInitializedSite(page);
  await page.getByRole('button', { name: 'New File', exact: true }).click();
  const name = page.getByRole('textbox', { name: 'New file name' });
  await name.fill('recovery-comparison.md');
  await name.press('Enter');
  const editor = page.locator('.ProseMirror[contenteditable="true"]').first();
  await expect(editor).toBeVisible();
  const savedText = 'Newer saved version from the debug app.';
  await editor.fill(savedText);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Object.keys(localStorage).filter((key) =>
            key.startsWith('docblocks:document-recovery:v1'),
          ).length,
      ),
    )
    .toBe(0);
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('docblocks:lastState')!);
    const targetKey = `${state.workspaceId}:${state.filePath.replace(/^\/+/, '')}`;
    const now = Date.now();
    localStorage.setItem(
      'docblocks:document-recovery:v1',
      JSON.stringify({
        schemaVersion: 1,
        records: [
          {
            targetKey,
            generation: 2,
            revision: 4,
            content: '# Older recovery draft\n\nThis was never saved.',
            persistedContent: '# Earlier baseline',
            createdAt: now - 3_600_000,
            updatedAt: now - 3_600_000,
          },
        ],
      }),
    );
  });
  await page.reload();
  const compare = page.getByRole('button', { name: 'Compare versions' });
  await expect(compare).toBeVisible({ timeout: 20_000 });
  await compare.click();
  const dialog = page.getByRole('dialog', { name: 'Compare document versions' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Recovery draft preview' })).toHaveValue(
    '# Older recovery draft\n\nThis was never saved.',
  );
  const saved = dialog.getByRole('textbox', { name: 'Saved file preview' });
  await expect(saved).not.toHaveValue(/Older recovery draft/);
  await expect(dialog).toContainText('Recovery copy captured:');
  await expect(dialog).toContainText('File last modified:');
  await dialog.screenshot({ path: 'reports/document-recovery/comparison.png' });

  await dialog.getByRole('button', { name: 'Decide later' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(compare).toBeVisible();
  await compare.click();
  await page.setViewportSize({ width: 390, height: 844 });
  const columns = dialog.locator('.db-conflict-version');
  await expect
    .poll(async () => {
      const [left, right] = await Promise.all([
        columns.nth(0).boundingBox(),
        columns.nth(1).boundingBox(),
      ]);
      return !!left && !!right && right.y >= left.y + left.height;
    })
    .toBe(true);
  await expect(dialog.getByRole('button', { name: 'Use saved file' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Use saved file' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(compare).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.locator('.ProseMirror').first()).toHaveText(savedText);
  await page.reload();
  await expect(page.locator('.ProseMirror').first()).toHaveText(savedText);
  await expect(compare).toHaveCount(0);
});
