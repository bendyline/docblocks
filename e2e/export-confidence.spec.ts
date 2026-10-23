import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './helpers/test.js';

test.use({ actionTimeout: 15_000 });

test('confirms a document download and previews the rendered video before saving', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a document', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'New document' });
  await create.getByLabel('Document name').fill('Client proposal');
  await create.getByRole('button', { name: 'Create', exact: true }).click();
  const editor = page.locator('.ProseMirror').first();
  await expect(editor).toContainText('Client proposal');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('Menu refresh: one draft and two revisions. Fixed fee: $1,200.');
  await expect(page.locator('.squisq-status-bar')).toContainText('13 words');

  await page.getByRole('button', { name: 'Export and share', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Export document...', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export Document' });
  await dialog.getByRole('radio', { name: 'PDF', exact: true }).click();
  await expect(dialog.getByRole('link', { name: 'Explore the DocBlocks CLI' })).toBeHidden();
  await page.screenshot({ path: info.outputPath('document-export.png') });
  const [pdf] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    dialog.getByRole('button', { name: 'Save PDF to Downloads', exact: true }).click(),
  ]);
  await pdf.saveAs(info.outputPath(pdf.suggestedFilename()));
  expect(await pdf.failure()).toBeNull();
  const result = page.getByRole('complementary', { name: 'Export result' });
  await expect(result).toContainText(pdf.suggestedFilename());
  await expect(result).toContainText('browser’s downloads');
  await page.screenshot({ path: info.outputPath('document-export-complete.png') });
  expect(
    (
      await new AxeBuilder({ page })
        .include('.db-export-completion')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  await result.getByRole('button', { name: 'Dismiss' }).click();

  await page.getByRole('button', { name: 'Export and share', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Export video...', exact: true }).click();
  const videoDialog = page.getByRole('dialog', { name: 'Export Video', exact: true });
  await expect(videoDialog).toBeVisible({ timeout: 30_000 });
  await videoDialog.getByRole('combobox', { name: 'Preset' }).selectOption('small');
  expect(
    (
      await new AxeBuilder({ page })
        .include('[data-squisq-video-export-modal]')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  await videoDialog.getByRole('button', { name: 'Export Video', exact: true }).click();
  const preview = videoDialog.locator('video[aria-label="Exported video preview"]');
  await expect(preview).toBeVisible({ timeout: 120_000 });
  await expect
    .poll(() => preview.evaluate((node: HTMLVideoElement) => node.readyState))
    .toBeGreaterThanOrEqual(1);
  expect(await preview.evaluate((node: HTMLVideoElement) => node.duration)).toBeGreaterThan(0);
  await preview.evaluate(async (node: HTMLVideoElement) => {
    await node.play();
  });
  await expect
    .poll(() => preview.evaluate((node: HTMLVideoElement) => node.currentTime))
    .toBeGreaterThan(0);
  await preview.evaluate((node: HTMLVideoElement) => node.pause());
  await page.screenshot({ path: info.outputPath('video-preview.png') });
  const [mp4] = await Promise.all([
    page.waitForEvent('download'),
    videoDialog.getByRole('button', { name: 'Save MP4 to Downloads', exact: true }).click(),
  ]);
  await mp4.saveAs(info.outputPath(mp4.suggestedFilename()));
  expect(await mp4.failure()).toBeNull();
});
