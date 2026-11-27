import type { Locator } from '@playwright/test';
import { expect, test } from './helpers/test.js';

/**
 * On a touch device, a dialog that takes typing opens in the upper part of the
 * screen and stays clear of the on-screen keyboard. iOS raises the keyboard over
 * the layout viewport without resizing it. useKeyboardInset publishes the
 * covered height as `--db-keyboard-inset`, which the emulated devices never
 * raise, so the test writes it directly.
 */

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

test.describe('Text-entry dialogs on touch devices', () => {
  test.skip(({ isMobile }) => isMobile !== true, 'touch-emulating projects only');

  test('open high and keep the field and actions above the keyboard', async ({ page }) => {
    // The first-run choice to paste something opens a dialog that takes typing.
    await page.goto('/');
    await page
      .getByRole('button', { name: /^Paste or (?:drop something|choose a file)$/ })
      .click({ timeout: 30_000 });
    const dialog = page.getByRole('dialog', { name: 'Start from something you have' });
    await expect(dialog).toBeVisible();
    const field = dialog.getByRole('textbox', { name: 'Text for the new document' });
    const create = dialog.getByRole('button', { name: 'Create document' });

    const viewportHeight = await page.evaluate(() => window.innerHeight);
    const panel = await boxOf(dialog);
    // Anchored in the upper part, not centered on the full layout viewport.
    // (A phone shows it as a sheet from the top edge down.)
    expect(panel.y).toBeLessThan(viewportHeight * 0.2);

    // Raise a keyboard over the bottom half, as iOS does.
    const keyboardTop = Math.round(viewportHeight / 2);
    await page.evaluate((inset) => {
      document.documentElement.style.setProperty('--db-keyboard-inset', `${inset}px`);
    }, viewportHeight - keyboardTop);

    for (const control of [field, create]) {
      const box = await boxOf(control);
      expect(box.y + box.height).toBeLessThanOrEqual(keyboardTop);
    }
    // The panel never reaches under the keyboard; its body scrolls instead.
    const raised = await boxOf(dialog);
    expect(raised.y + raised.height).toBeLessThanOrEqual(keyboardTop);
  });
});
