import type { Page } from '@playwright/test';
import { expect, test } from './helpers/test.js';
import { viewButton } from './helpers/toolbar.js';

/**
 * The Summarization designer in a small panel. The designer is Squisq's, shown
 * inline in View › Edit › Summaries when Custom is chosen. Its two columns, the slide
 * list beside the selected slide, would each scroll in a sliver in a VS Code
 * editor pane or on a phone, so below a width the list becomes a picker and the
 * designer scrolls as one. The panel's own size decides, not the shell's
 * stamped width, because the VS Code webview has no shell to stamp it.
 */

const SIZES = [
  { name: 'a VS Code editor pane', width: 590, height: 515, compact: true },
  { name: 'a phone in portrait', width: 390, height: 664, compact: true },
  { name: 'a laptop window', width: 1280, height: 800, compact: false },
] as const;

async function openWelcome(page: Page): Promise<void> {
  await page.goto('/');
  const shell = page.locator('.db-shell');
  await expect(shell).toBeVisible();
  const tour = page.getByRole('button', { name: 'Tour the welcome document' });
  const startWriting = page.locator('.db-welcome-gateway-cta');
  await expect(tour.or(startWriting).first()).toBeVisible({ timeout: 30_000 });
  await ((await tour.count()) > 0 ? tour : startWriting).click();
  await expect(page.locator('.squisq-toolbar')).toBeVisible({ timeout: 30_000 });
  // The toolbar shows before the welcome document's hash navigation and, in
  // single-pane, before the file drawer closes. Either can re-render it and
  // close a menu opened in that gap, so settle first.
  await expect
    .poll(() => decodeURIComponent(new URL(page.url()).hash), { timeout: 30_000 })
    .toMatch(/\/Welcome\.md$/i);
  if ((await shell.getAttribute('data-db-layout')) === 'single-pane')
    await expect(shell).toHaveAttribute('data-db-drawer', 'closed');
}

/**
 * View › Edit › Summaries, then Custom. A resize can re-render the toolbar and
 * close a menu opened in the same frame, so retry the whole open until it shows.
 */
async function openDesigner(page: Page) {
  const summarize = page.getByRole('region', { name: 'Summaries', exact: true });
  const designer = summarize.getByRole('region', { name: 'Summarization designer', exact: true });
  const viewMenu = page.getByRole('menu', { name: 'View', exact: true });
  await expect(async () => {
    if (await designer.isVisible()) return;
    if (!(await summarize.isVisible())) {
      if (!(await viewMenu.isVisible())) await viewButton(page).click({ timeout: 2_000 });
      await viewMenu
        .getByRole('group', { name: 'Edit', exact: true })
        .getByRole('menuitemradio', { name: 'Summaries', exact: true })
        .click({ timeout: 2_000 });
    }
    await summarize.getByRole('radio', { name: 'Custom', exact: true }).check({ timeout: 2_000 });
    await expect(designer).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  // The inline designer stays mounted across a resize and keeps the slide the
  // previous step left selected, so wait for any slide's preview, not Slide 1.
  await expect(designer.getByRole('img', { name: /^Slide \d+/ })).toBeVisible({ timeout: 30_000 });
  return { summarize, designer };
}

test('fits the Summarization designer to small panels with a slide picker', async ({ page }) => {
  await page.setViewportSize({ width: SIZES[0].width, height: SIZES[0].height });
  await openWelcome(page);
  for (const size of SIZES) {
    await test.step(size.name, async () => {
      await page.setViewportSize({ width: size.width, height: size.height });
      const { summarize, designer } = await openDesigner(page);
      const list = designer.getByRole('navigation', { name: 'Presentation slides' });
      const picker = designer.getByRole('combobox', { name: 'Slide', exact: true });
      if (!size.compact) {
        await expect(list.getByRole('button').first()).toBeVisible();
        await expect(picker).toBeHidden();
        return;
      }
      await expect(list).toBeHidden();
      await expect(picker).toBeVisible();
      await picker.selectOption({ index: 0 });
      await expect(designer.getByRole('button', { name: 'Previous slide' })).toBeDisabled();
      expect(await picker.locator('option').count()).toBeGreaterThan(2);

      await picker.selectOption({ index: 2 });
      await expect(designer.getByRole('img', { name: /^Slide 3/ })).toBeVisible();
      await designer.getByRole('button', { name: 'Next slide' }).click();
      await expect(designer.getByRole('img', { name: /^Slide 4/ })).toBeVisible();
      await expect(picker).toHaveValue('3');

      // One column, never a column clipped inside it, and never sideways.
      const detail = designer.locator('.squisq-summary-designer-detail');
      expect(await detail.evaluate((node) => node.scrollHeight - node.clientHeight)).toBe(0);
      expect(
        await summarize.evaluate((node) => node.scrollWidth - node.clientWidth),
      ).toBeLessThanOrEqual(1);
      const source = designer.getByRole('region', { name: 'Original document text' });
      await source.scrollIntoViewIfNeeded();
      await expect(source).toBeInViewport();
      const preview = await designer.getByRole('img', { name: /^Slide 4/ }).boundingBox();
      expect(preview!.height, 'the preview keeps a usable height').toBeGreaterThanOrEqual(120);
    });
  }
});
