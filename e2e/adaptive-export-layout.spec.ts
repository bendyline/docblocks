import type { Locator, Page } from '@playwright/test';
import { expect, test } from './helpers/test.js';

async function openWelcome(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Tour the welcome document', exact: true }).click();
  await page.getByRole('tab', { name: 'Write', exact: true }).click();
}

async function expectFits(element: Locator) {
  await expect(element).toBeVisible();
  await expect
    .poll(() =>
      element.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return (
          rect.left >= 0 && rect.right <= innerWidth && node.scrollWidth <= node.clientWidth + 1
        );
      }),
    )
    .toBe(true);
}

for (const width of [320, 390, 412]) {
  test(`advanced editor views and video export fit at ${width}px`, async ({ page }, info) => {
    test.skip(info.project.name.startsWith('ipad'), 'phone projects only');
    await page.setViewportSize({ width, height: 844 });
    await openWelcome(page);
    const editor = page.locator('.ProseMirror').first();
    for (const mode of ['Block-at-a-time', 'Timeline']) {
      await page.getByRole('button', { name: 'View options', exact: true }).click();
      await page.getByRole('menuitemradio', { name: mode, exact: true }).click();
      const previews = page.getByRole('menuitemcheckbox', {
        name: 'Show block previews',
        exact: true,
      });
      if ((await previews.getAttribute('aria-checked')) !== 'true') await previews.click();
      await page.keyboard.press('Escape');
      // Hiding the decorative panel must reclaim editing space, not just clip it.
      await expect(page.locator('.squisq-block-preview-panel')).toBeHidden();
      await expect
        .poll(async () => (await editor.boundingBox())!.width)
        .toBeGreaterThan(width - 80);
      await expectFits(editor);
      await page.screenshot({ path: info.outputPath(`${mode}-${width}.png`) });
    }
    const originalEditor = await editor.elementHandle();
    const text = await editor.textContent();
    await page.setViewportSize({ width: 1400, height: 1000 });
    await expect(page.locator('.squisq-block-preview-panel')).toBeVisible();
    expect(await originalEditor!.evaluate((node) => node.isConnected)).toBe(true);
    await expect(editor).toHaveText(text!);
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator('.squisq-block-preview-panel')).toBeHidden();

    await page.getByRole('button', { name: 'Export and share', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Export video...', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Export Video', exact: true });
    await expectFits(dialog);
    await expect(dialog.getByRole('combobox', { name: 'Quality', exact: true })).toBeHidden();
    await dialog.getByRole('combobox', { name: 'Preset' }).selectOption('social');
    await expect(dialog).toContainText('Portrait');
    await page.screenshot({ path: info.outputPath(`video-presets-${width}.png`) });
    await dialog.locator('summary', { hasText: 'Advanced options' }).click();
    await page.setViewportSize({ width, height: 360 });
    await expectFits(dialog);
    await expect.poll(async () => (await dialog.boundingBox())!.height).toBeLessThanOrEqual(336);
    const animations = dialog.getByRole('combobox', { name: 'Animations and transitions' });
    await animations.scrollIntoViewIfNeeded();
    await animations.selectOption('disabled');
    const exportButton = dialog.getByRole('button', { name: 'Export Video', exact: true });
    await exportButton.scrollIntoViewIfNeeded();
    await expect(exportButton).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`video-short-${width}.png`) });
    await dialog.getByRole('button', { name: 'Close export dialog' }).click();
    await expect(dialog).toBeHidden();
  });
}
