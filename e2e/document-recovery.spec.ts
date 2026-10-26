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
  // The welcome document's editor is in Write too until this one replaces it.
  const editor = page.getByRole('textbox', { name: /^Edit \/?recovery-comparison\.md$/ });
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
  // Real drafts are journaled from editor output, so this one uses the
  // editor's canonical serialization. Without the final newline, the editor
  // normalizes the restored draft at a racy moment after reload and the
  // preview below would sometimes show the normalized copy instead.
  const draft = '# Older recovery draft\n\nThis was never saved.\n';
  await page.evaluate((draft) => {
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
            content: draft,
            persistedContent: '# Earlier baseline',
            createdAt: now - 3_600_000,
            updatedAt: now - 3_600_000,
          },
        ],
      }),
    );
  }, draft);
  await page.reload();
  const compare = page.getByRole('button', { name: 'Compare versions' });
  await expect(compare).toBeVisible({ timeout: 20_000 });
  await compare.click();
  const dialog = page.getByRole('dialog', { name: 'Compare document versions' });
  await expect(dialog).toBeVisible();
  const recovered = dialog.getByRole('region', { name: 'Recovery draft preview' });
  await expect(recovered.getByRole('heading', { name: 'Older recovery draft' })).toBeVisible();
  await expect(recovered).toContainText('This was never saved.');
  const saved = dialog.getByRole('region', { name: 'Saved file preview' });
  await expect(saved).toBeVisible();
  await expect(saved).not.toContainText('Older recovery draft');
  // The source diff between them: Monaco loads lazily, so wait for its lines.
  await expect(
    dialog
      .getByRole('region', { name: 'Differences' })
      .locator('.monaco-diff-editor .view-line')
      .first(),
  ).toBeVisible({ timeout: 20_000 });
  // An explicit side-by-side choice holds in the middle pane, where Monaco
  // would otherwise fall back to inline for lack of width.
  const diffView = dialog.getByRole('combobox', { name: 'View' });
  const diffEditor = dialog.locator('.monaco-diff-editor');
  await expect(diffView).toHaveValue('inline');
  await expect(diffEditor).not.toHaveClass(/side-by-side/);
  await diffView.selectOption('side-by-side');
  await expect(diffEditor).toHaveClass(/side-by-side/);
  await diffView.selectOption('inline');
  await expect(diffEditor).not.toHaveClass(/side-by-side/);
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
