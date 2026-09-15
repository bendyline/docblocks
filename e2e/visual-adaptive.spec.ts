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
 * The document canvas, masked out of every adaptive capture.
 *
 * These baselines are about *layout* — which panes exist, how wide they are,
 * whether a drawer covers the editor. What the document renders inside is not
 * part of that, and it settles late: proofing squiggles, diagram canvases and
 * slideshow thumbnails all arrive after the shell itself is final.
 *
 * Scoped to the editable canvas and the slideshow rail rather than the whole
 * editor shell. Masking the shell looks equivalent until you look at the
 * result: in single-pane the shell *is* the viewport, so the baseline comes out
 * a solid rectangle asserting nothing at all. The toolbar, the drawer, the
 * scrim and the pane edges all have to stay visible for the image to be worth
 * committing.
 */
function documentCanvas(page: Page): readonly Locator[] {
  return [
    page.locator('[contenteditable="true"]'),
    page.locator('.squisq-slideshow-rail'),
    // The status readouts are derived from the document and settle on their own
    // schedule — the proofing issue count last of all, once harper has run.
    // They sit outside the canvas, so they need naming separately.
    page.locator('.squisq-status-item'),
  ];
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

  /*
   * There is deliberately no baseline for the phone editor at rest.
   *
   * It renders bimodally — a fixed ~144-pixel difference appearing in roughly
   * one run in three, with the document canvas, slideshow rail and status
   * readouts already masked. The remaining variance has not been identified.
   *
   * Little is lost: the same surface at desktop width is covered by the
   * `shell-light` and `shell-dark` baselines, and the phone layout contract —
   * single pane, coarse pointer, both panes mounted — is asserted structurally
   * by `adaptive-shell.spec.ts`. The drawer capture below is the one that shows
   * something those do not.
   */

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
      mask: documentCanvas(page),
    });
  });
});

/*
 * There are deliberately no tablet baselines.
 *
 * The split-pane capture differs between otherwise identical runs about one
 * time in four, by roughly 2% of the image, with the document canvas, the
 * slideshow rail and the status readouts already masked. Whatever remains has
 * not been identified, and a baseline that fails a quarter of the time teaches
 * people to ignore the suite — which costs more than the coverage is worth.
 *
 * Both tablet layouts are still asserted structurally by
 * `adaptive-shell.spec.ts`, which checks the stamped `data-db-layout`,
 * `data-db-form-factor` and resizer presence for landscape and portrait. Add
 * baselines here once the residual variance is understood; do not reach for a
 * `maxDiffPixelRatio` that would also swallow a real regression.
 */
