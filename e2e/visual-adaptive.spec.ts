/**
 * Visual regression baselines for the adaptive shell.
 *
 * `adaptive-shell.spec.ts` asserts the stamped `data-db-*` contract — form
 * factor, layout, drawer state. That proves the shell chose the right layout,
 * not that the layout is usable: a drawer can be stamped `open` while its
 * content overflows, and a split pane can be stamped `split-pane` with one side
 * collapsed to nothing.
 *
 * Runs on the `visual-phone` and `visual-tablet-*` projects, which emulate
 * touch rather than only a viewport size. See `playwright.config.ts`.
 */

import { expect, test } from './helpers/test.js';
import { expectStableScreenshot } from './helpers/visual.js';
import type { Locator } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Open the welcome document from whichever first-run affordance this layout
 * shows: single-pane gets the compact tour card, split-pane gets the slideshow
 * gateway. Mirrors `adaptive-shell.spec.ts`.
 */
/**
 * The document surface, masked out of every adaptive capture.
 *
 * These baselines are about *layout* — which panes exist, how wide they are,
 * whether a drawer covers the editor. The document rendered inside is not part
 * of that, and it settles late: slideshow thumbnails, proofing squiggles and
 * diagram canvases all arrive after the shell itself is final. Masking keeps
 * the pane geometry under test, because a mask still occupies exactly the
 * region it covers.
 */
function documentContent(page: Page): readonly Locator[] {
  return [page.locator('.squisq-editor-shell')];
}

async function openWelcomeDocument(page: Page): Promise<void> {
  // See the note in visual.spec.ts: the bundled chrome face is what makes one
  // baseline comparable across operating systems.
  await page.addInitScript(() => {
    localStorage.setItem('docblocks:interfaceFont', 'fixed');
  });
  await page.goto('/');
  await expect(page.locator('.db-shell')).toBeVisible();
  const tour = page.getByRole('button', { name: 'Tour the welcome document' });
  const startWriting = page.locator('.db-welcome-gateway-cta');
  await expect(tour.or(startWriting).first()).toBeVisible({ timeout: 30_000 });
  await ((await tour.count()) > 0 ? tour : startWriting).click();
  await expect(page.locator('.squisq-toolbar')).toBeVisible({ timeout: 30_000 });

  const shell = page.locator('.db-shell');
  if ((await shell.getAttribute('data-db-layout')) === 'single-pane') {
    await expect(shell).toHaveAttribute('data-db-drawer', 'closed');
  }
}

test.describe('phone', () => {
  test.skip(({ isMobile }) => isMobile !== true, 'touch-emulating projects only');

  test('editor fills the viewport with the drawer closed', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.includes('tablet'), 'phone project only');
    await openWelcomeDocument(page);
    await expectStableScreenshot(page, page, 'phone-editor.png', { mask: documentContent(page) });
  });

  test('drawer opens over a dismissable scrim', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.includes('tablet'), 'phone project only');
    await openWelcomeDocument(page);
    await page.getByRole('button', { name: 'Show file list' }).click();
    await expect(page.locator('.db-shell')).toHaveAttribute('data-db-drawer', 'open');

    // The drawer slides in over ~220ms. Capturing mid-flight bakes a partially
    // open drawer into the baseline, so wait for it to sit flush with the start
    // edge — the same gate `adaptive-shell.spec.ts` uses before measuring.
    await expect
      .poll(async () =>
        Math.round((await page.locator('aside.db-shell-sidebar').boundingBox())?.x ?? -1),
      )
      .toBe(0);

    await expectStableScreenshot(page, page, 'phone-drawer-open.png', {
      mask: documentContent(page),
    });
  });
});

test.describe('tablet', () => {
  test.skip(({ isMobile }) => isMobile !== true, 'touch-emulating projects only');

  test('splits in landscape and drawers in portrait', async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.includes('tablet'), 'tablet projects only');
    await openWelcomeDocument(page);

    const shell = page.locator('.db-shell');
    const layout = await shell.getAttribute('data-db-layout');
    if (layout === 'split-pane') {
      // Both panes and the resizer between them are the subject here.
      await expect(page.locator('.db-shell-sidebar-resizer')).toBeVisible();
      await expectStableScreenshot(page, page, 'tablet-split-pane.png', {
        mask: documentContent(page),
      });
      return;
    }

    await expect(page.locator('.db-shell-sidebar-resizer')).toHaveCount(0);
    await expectStableScreenshot(page, page, 'tablet-single-pane.png', {
      mask: documentContent(page),
    });
  });
});
