import type { Page } from '@playwright/test';
import { expect, test } from './helpers/test.js';

/**
 * The Summarization designer in a small panel. Its two columns, the slide list
 * beside the selected slide, each scrolled inside a sliver in a VS Code editor
 * pane and on a phone, so below a size the list becomes a picker and the
 * dialog body scrolls as one. The panel's own size decides, not the shell's
 * stamped width, because the VS Code webview has no shell to stamp it.
 */

const SIZES = [
  { name: 'a VS Code editor pane', width: 590, height: 515, compact: true },
  { name: 'a phone in portrait', width: 390, height: 664, compact: true },
  { name: 'a phone in landscape', width: 844, height: 390, compact: true },
  { name: 'a laptop window', width: 1280, height: 800, compact: false },
] as const;

async function openWelcomeInSlideshow(page: Page): Promise<void> {
  await page.goto('/');
  const shell = page.locator('.db-shell');
  await expect(shell).toBeVisible();
  const tour = page.getByRole('button', { name: 'Tour the welcome document' });
  const startWriting = page.locator('.db-welcome-gateway-cta');
  await expect(tour.or(startWriting).first()).toBeVisible({ timeout: 30_000 });
  await ((await tour.count()) > 0 ? tour : startWriting).click();
  await expect(page.locator('.squisq-toolbar')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Choose Use mode', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Slideshow', exact: true }).click();
}

/**
 * A resize re-fits the preview toolbar over the next few frames: widening to a
 * laptop first lays the toolbar out full width, then the shell shows its
 * sidebar and the toolbar narrows again. The designer button can sit inline in
 * one frame and in the closed overflow menu the next, so one visibility check
 * picks the wrong path and the click then waits on a button that is gone.
 * Retry the whole open until the dialog shows.
 */
async function openDesigner(page: Page) {
  const button = page.getByRole('button', { name: 'Summarization designer', exact: true });
  const more = page.getByRole('button', { name: 'More preview settings', exact: true });
  const designer = page.getByRole('dialog', { name: 'Summarization designer', exact: true });
  await expect(async () => {
    if (await designer.isVisible()) return;
    if (
      !(await button.isVisible()) &&
      (await more.getAttribute('aria-expanded', { timeout: 2_000 })) !== 'true'
    )
      await more.click({ timeout: 2_000 });
    await button.click({ timeout: 2_000 });
    await expect(designer).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  await expect(designer.getByRole('img', { name: /^Slide 1/ })).toBeVisible({ timeout: 30_000 });
  return designer;
}

test('fits the Summarization designer to small panels with a slide picker', async ({ page }) => {
  await page.setViewportSize({ width: SIZES[0].width, height: SIZES[0].height });
  await openWelcomeInSlideshow(page);
  for (const size of SIZES) {
    await test.step(size.name, async () => {
      await page.setViewportSize({ width: size.width, height: size.height });
      const designer = await openDesigner(page);
      const list = designer.getByRole('navigation', { name: 'Presentation slides' });
      const picker = designer.getByRole('combobox', { name: 'Slide', exact: true });
      const body = designer.locator('.db-dialog-body');
      if (!size.compact) {
        await expect(list.getByRole('button').first()).toBeVisible();
        await expect(picker).toBeHidden();
        await page.keyboard.press('Escape');
        return;
      }
      await expect(list).toBeHidden();
      await expect(picker).toBeVisible();
      await expect(designer.getByRole('button', { name: 'Previous slide' })).toBeDisabled();
      expect(await picker.locator('option').count()).toBeGreaterThan(2);

      await picker.selectOption({ index: 2 });
      await expect(designer.getByRole('img', { name: /^Slide 3/ })).toBeVisible();
      await designer.getByRole('button', { name: 'Next slide' }).click();
      await expect(designer.getByRole('img', { name: /^Slide 4/ })).toBeVisible();
      await expect(picker).toHaveValue('3');

      // One scroller: the body, never a column clipped inside it, and never sideways.
      const detail = designer.locator('.db-presentation-detail');
      expect(await detail.evaluate((node) => node.scrollHeight - node.clientHeight)).toBe(0);
      expect(
        await body.evaluate((node) => node.scrollWidth - node.clientWidth),
      ).toBeLessThanOrEqual(1);
      const source = designer.getByRole('region', { name: 'Original document text' });
      await source.scrollIntoViewIfNeeded();
      await expect(source).toBeInViewport();
      const preview = await designer.getByRole('img', { name: /^Slide 4/ }).boundingBox();
      expect(preview!.height, 'the preview keeps a usable height').toBeGreaterThanOrEqual(120);
      await expect(designer.getByRole('button', { name: 'Use dynamic slides' })).toBeInViewport();
      await page.keyboard.press('Escape');
      await expect(designer).toBeHidden();
    });
  }
});
