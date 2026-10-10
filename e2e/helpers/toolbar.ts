import type { Page } from '@playwright/test';
import { expect } from './test.js';

/**
 * Squisq's Insert control, wherever the toolbar put it: the inline `+`
 * button, or the `Insert...` entry in the More actions menu once the row is
 * too narrow to keep it. Newer Squisq collapses Insert last; older releases
 * collapsed it first. Tests that only need Insert should not care which.
 */
export async function openInsertMenu(page: Page): Promise<void> {
  const toolbar = page.locator('.squisq-toolbar');
  const inline = toolbar
    .locator('.squisq-toolbar-actions')
    .getByRole('button', { name: 'Insert', exact: true });
  const more = toolbar.locator('.squisq-toolbar-overflow-trigger');

  // Before the toolbar's width measurement runs, a button that is about to
  // collapse can still read as visible but sit clipped past the row's edge.
  // Wait for a settled state: either the ··· trigger is up, or Insert sits
  // wholly inside the actions row.
  await expect
    .poll(async () => {
      if (await more.isVisible()) return true;
      return inline.evaluate((button) => {
        const row = button.closest('.squisq-toolbar-actions')?.getBoundingClientRect();
        const rect = button.getBoundingClientRect();
        return (
          !!row &&
          rect.width > 0 &&
          getComputedStyle(button).visibility !== 'hidden' &&
          rect.right <= row.right
        );
      });
    })
    .toBe(true);

  if (await more.isVisible()) {
    await more.click();
    const fromMenu = page
      .locator('.squisq-toolbar-overflow-menu')
      .getByRole('button', { name: 'Insert...' });
    if (await fromMenu.isVisible()) {
      await fromMenu.click();
      await expect(page.locator('.squisq-insert-menu').first()).toBeVisible();
      return;
    }
    await more.click();
  }
  await inline.click();
  await expect(page.locator('.squisq-insert-menu').first()).toBeVisible();
}
