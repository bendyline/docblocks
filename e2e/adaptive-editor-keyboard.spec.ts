import type { Page } from '@playwright/test';
import { expect, test } from './helpers/test.js';
import { selectWriteMode, showWriteView } from './helpers/toolbar.js';

/**
 * On a touch device the editor shrinks above the on-screen keyboard, so the
 * caret stays in view while typing. iOS raises the keyboard over the layout
 * viewport without resizing it; useKeyboardInset publishes the covered height
 * as `--db-keyboard-inset` on <html>, which the emulated devices never raise,
 * so the test writes it there directly, as the hook does.
 *
 * Block-at-a-time mode is the sharp case: a single block rarely overflows the
 * full-height editor, so unless the editor itself shrinks there is nothing to
 * scroll and the new lines run on under the keyboard.
 */

/** Bottom edge of the caret, in client coordinates. */
function caretBottom(page: Page): Promise<number> {
  return page.evaluate(() => {
    const selection = document.getSelection();
    const node = selection?.focusNode;
    if (!selection || !node) throw new Error('no selection');
    const range = document.createRange();
    range.setStart(node, selection.focusOffset);
    const rects = range.getClientRects();
    const rect = rects.length > 0 ? rects[rects.length - 1] : null;
    if (rect && rect.height > 0) return rect.bottom;
    const element = node instanceof Element ? node : node.parentElement;
    return element!.getBoundingClientRect().bottom;
  });
}

test.describe('Editing above the on-screen keyboard', () => {
  test.skip(({ isMobile }) => isMobile !== true, 'touch-emulating projects only');

  test('a block keeps the caret above the keyboard as it grows', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Tour the welcome document', exact: true }).click();
    await showWriteView(page);
    await selectWriteMode(page, 'Blocks');

    // A block with a list, so Enter keeps adding lines to the same block.
    const editor = page.locator('.tiptap.ProseMirror').first();
    const item = editor.locator('li').last();
    await expect(async () => {
      if ((await editor.locator('li').count()) > 0) return;
      await page.getByRole('button', { name: 'Next block', exact: true }).click();
      expect(await editor.locator('li').count()).toBeGreaterThan(0);
    }).toPass({ timeout: 30_000 });

    await item.click();
    await item.evaluate((li) => {
      const range = document.createRange();
      range.selectNodeContents(li.querySelector('p') ?? li);
      range.collapse(false);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
    });

    // Raise a keyboard over the bottom half, as iOS does.
    const viewportHeight = await page.evaluate(() => window.innerHeight);
    const keyboardTop = Math.round(viewportHeight / 2);
    await page.evaluate((inset) => {
      document.documentElement.style.setProperty('--db-keyboard-inset', `${inset}px`);
    }, viewportHeight - keyboardTop);

    // The card's navigation rides up with the editor rather than staying under the keyboard.
    const nav = page.locator('.squisq-block-card-nav');
    await expect
      .poll(async () => {
        const box = (await nav.boundingBox())!;
        return box.y + box.height;
      })
      .toBeLessThanOrEqual(keyboardTop);

    for (let line = 1; line <= 12; line++) {
      await page.keyboard.press('Enter');
      await page.keyboard.type(`Typed line ${line}`);
      await expect.poll(() => caretBottom(page)).toBeLessThanOrEqual(keyboardTop);
    }
    await expect(editor).toContainText('Typed line 12');
  });
});
