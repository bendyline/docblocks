import type { Page } from '@playwright/test';
import { expect, test } from './helpers/test.js';

/**
 * A finger cannot hover, so on a phone or tablet a squiggle answers a tap: the
 * tap raises the proofing card, and the card's buttons fix the word.
 *
 * The WebKit projects stand in for iPhone and iPad, where this once failed
 * outright: WebKit reports a finger's click as `pointerType: "mouse"`, so
 * every tap read as a mouse click and no card appeared. The Source view's tap
 * card is covered upstream, in Squisq's `e2e/proofing-touch.spec.ts`.
 */

const squiggle = (page: Page) => page.locator('.tiptap [data-proof-id]', { hasText: /^teh$/ });
const card = (page: Page) => page.locator('.squisq-proof-tooltip');

/** Open the welcome document in Write with a misspelling just under its title. */
async function openWriteWithTypo(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.db-shell')).toBeVisible();
  const tour = page.getByRole('button', { name: 'Tour the welcome document' });
  const startWriting = page.locator('.db-welcome-gateway-cta');
  await expect(tour.or(startWriting).first()).toBeVisible({ timeout: 30_000 });
  await ((await tour.count()) > 0 ? tour : startWriting).click();
  const editor = page.locator('.tiptap[contenteditable="true"]');
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await page
    .locator('.tiptap h1')
    .first()
    .evaluate((heading) => {
      (heading.closest('[contenteditable="true"]') as HTMLElement).focus();
      const range = document.createRange();
      range.selectNodeContents(heading);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('This is teh probe.');
  await editor.blur();
  // Cold engine setup precedes the first squiggle.
  await expect(squiggle(page)).toBeVisible({ timeout: 60_000 });
  // The edit sets off more than one pass, and each re-issues the finding's id
  // and redraws its squiggle. A tap across a redraw lands on no squiggle, so
  // wait until the id holds for longer than the 450 ms lint debounce.
  let lastId: string | null = null;
  await expect
    .poll(
      async () => {
        const id = await squiggle(page).getAttribute('data-proof-id');
        const settled = id !== null && id === lastId;
        lastId = id;
        return settled;
      },
      { intervals: [1_000], timeout: 30_000 },
    )
    .toBe(true);
  // Mid-screen, clear of the toolbar above and the status bar below.
  await squiggle(page).evaluate((word) => word.scrollIntoView({ block: 'center' }));
}

test.describe('Proofing squiggles on touch devices', () => {
  test.skip(({ isMobile }) => isMobile !== true, 'touch-emulating projects only');

  test('a tap on a squiggle raises its card, and a second tap puts it away', async ({ page }) => {
    test.setTimeout(120_000);
    await openWriteWithTypo(page);

    await squiggle(page).tap();
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toHaveAttribute('data-trigger', 'tap');
    await expect(card(page).getByRole('button', { name: 'Ignore', exact: true })).toBeVisible();

    await squiggle(page).tap();
    await expect(card(page)).toHaveCount(0);
  });

  test('a suggestion on the card fixes the word', async ({ page }) => {
    test.setTimeout(120_000);
    await openWriteWithTypo(page);

    await squiggle(page).tap();
    await card(page).getByRole('button', { name: 'the', exact: true }).tap();
    await expect(card(page)).toHaveCount(0);
    await expect(page.locator('.tiptap')).toContainText('This is the probe.');
    await expect(squiggle(page)).toHaveCount(0);
  });
});
