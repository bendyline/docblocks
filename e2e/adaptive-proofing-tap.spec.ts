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
  // The welcome screen leaves the editor inert, and visible, until its close
  // commits, and focus cannot enter an inert subtree. A caret placed before
  // then never reaches ProseMirror, and when the shell focuses the editor a
  // moment later ProseMirror puts the caret back at the start of the document.
  await expect
    .poll(() => editor.evaluate((element) => element.closest('[inert]') === null))
    .toBe(true);
  const heading = page.locator('.tiptap h1').first();
  // ProseMirror learns of a caret placed from script only through the
  // selectionchange event, and does not read the DOM caret again when a key
  // goes down: Enter pressed before the event arrives splits the title at
  // ProseMirror's own caret, the start of the document, and the probe is typed
  // into the title. On a busy page WebKit delivers the event hundreds of
  // milliseconds late, and until then ProseMirror can also write its own caret
  // back over this one (20 ms after the editor takes focus, or on a redraw).
  // So wait for the event, then check that the caret held; place it again if
  // it did not.
  await expect(async () => {
    const held = await heading.evaluate(async (title) => {
      const delivered = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 5_000);
        document.addEventListener(
          'selectionchange',
          () => {
            clearTimeout(timer);
            // ProseMirror re-adds its listener after every redraw, so it can
            // run after this one; and its focus check runs 20 ms after focus.
            setTimeout(() => resolve(true), 50);
          },
          { once: true },
        );
      });
      (title.closest('[contenteditable="true"]') as HTMLElement).focus();
      // The end of the title's own text: the template badges after it are not
      // editable, and a caret beyond them is one ProseMirror has to move.
      const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) =>
          node.parentElement?.closest('[contenteditable="false"]')
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT,
      });
      let text: Node | null = null;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) text = node;
      const selection = window.getSelection();
      if (!text || !selection) return false;
      const end = document.createRange();
      end.setStart(text, text.textContent?.length ?? 0);
      end.collapse(true);
      selection.removeAllRanges();
      selection.addRange(end.cloneRange());
      if (!(await delivered) || selection.rangeCount === 0) return false;
      const caret = selection.getRangeAt(0);
      return (
        caret.collapsed &&
        title.contains(caret.startContainer) &&
        caret.compareBoundaryPoints(Range.START_TO_START, end) >= 0
      );
    });
    expect(held, 'the caret holds at the end of the title').toBe(true);
  }).toPass({ timeout: 30_000 });
  await expect(editor).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('This is teh probe.');
  // Its own paragraph under the title: typed into the title instead, the probe
  // draws no squiggle, and the wait below would time out without saying why.
  await expect(editor.locator('p', { hasText: /^This is teh probe\.$/ })).toBeVisible();
  await expect(heading).not.toContainText('probe');
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
