import AxeBuilder from '@axe-core/playwright';
import { MONACO_COLD_LOAD_TIMEOUT } from './helpers/editor-regression.js';
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
  // Seed exact export content without depending on rich-text caret navigation:
  // Ctrl+End followed by Enter could put the body inside the heading on Linux.
  const body = 'Menu refresh: one draft and two revisions. Fixed fee: $1,200.';
  await page.getByRole('tab', { name: 'Source', exact: true }).click();
  await page.locator('.monaco-editor .view-lines').click({ timeout: MONACO_COLD_LOAD_TIMEOUT });
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(`# Client proposal\n\n${body}\n`);
  await page.getByRole('tab', { name: 'Write', exact: true }).click();
  await expect(editor.getByRole('heading', { level: 1 })).toHaveText('Client proposal');
  await expect(editor.locator('p')).toHaveText(body);

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
