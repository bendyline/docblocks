import type { Page } from '@playwright/test';
import { expect, test } from './helpers/test.js';

/**
 * Layout behaviour of the adaptive shell. Runs on the touch-emulating device
 * projects declared in playwright.config.ts, so `data-db-pointer` is really
 * `coarse` here rather than a viewport size standing in for one.
 */

async function openWelcomeDocument(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.db-shell')).toBeVisible();
  // Each test gets a fresh context, so a first-run gateway is deterministic --
  // but which one depends on the layout. Single-pane shows the compact
  // first-run card; split-pane shows the slideshow gateway. Wait for whichever
  // arrives rather than probing: `isVisible()` on a not-yet-rendered gateway
  // returns false immediately and silently skips opening the document.
  const tour = page.getByRole('button', { name: 'Tour the welcome document' });
  const startWriting = page.locator('.db-welcome-gateway-cta');
  await expect(tour.or(startWriting).first()).toBeVisible({ timeout: 30_000 });
  await ((await tour.count()) > 0 ? tour : startWriting).click();
  await expect(page.locator('.squisq-toolbar')).toBeVisible({ timeout: 30_000 });
  // In single-pane the tour hands the viewport to the editor; wait for the
  // drawer to finish closing so probes read a settled layout.
  const shell = page.locator('.db-shell');
  if ((await shell.getAttribute('data-db-layout')) === 'single-pane') {
    await expect(shell).toHaveAttribute('data-db-drawer', 'closed');
  }
}

/** The stamped contract that `docblocks.css` keys off. */
async function layoutAttributes(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    return {
      width: root.getAttribute('data-db-width'),
      formFactor: root.getAttribute('data-db-form-factor'),
      pointer: root.getAttribute('data-db-pointer'),
      layout: root.getAttribute('data-db-layout'),
      drawer: root.getAttribute('data-db-drawer'),
    };
  });
}

test.describe('adaptive shell on a phone', () => {
  test.skip(({ isMobile }) => isMobile !== true, 'touch-emulating projects only');

  test('stamps a coarse single-pane form factor and keeps both panes mounted', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name.startsWith('ipad'), 'phone projects only');
    await openWelcomeDocument(page);

    const attributes = await layoutAttributes(page);
    expect(attributes.pointer).toBe('coarse');
    expect(attributes.formFactor).toBe('phone');
    expect(attributes.layout).toBe('single-pane');

    // Both panes exist even though only one is reachable.
    await expect(page.locator('aside.db-shell-sidebar')).toHaveCount(1);
    await expect(page.locator('main.db-shell-editor-area')).toHaveCount(1);
  });

  test('opens the drawer without tearing down the editor', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.startsWith('ipad'), 'phone projects only');
    await openWelcomeDocument(page);

    // Tag the live editor node so we can prove identity across the toggle.
    // Unmounting it would destroy Tiptap, Monaco, undo history and scroll
    // position — the regression this layout exists to prevent.
    await page.evaluate(() => {
      const editor = document.querySelector('.squisq-editor-shell');
      if (!editor) throw new Error('editor shell not found');
      (editor as HTMLElement).dataset.identityProbe = 'original';
    });

    await page.getByRole('button', { name: 'Show file list' }).click();
    await expect(page.locator('.db-shell')).toHaveAttribute('data-db-drawer', 'open');
    await expect(page.locator('main.db-shell-editor-area')).toHaveAttribute('inert', '');

    // The drawer slides in over ~220ms. Wait for it to settle flush with the
    // start edge before measuring anything: a boundingBox() taken mid-flight
    // reports the off-screen position and every derived coordinate is wrong.
    await expect
      .poll(async () =>
        Math.round((await page.locator('aside.db-shell-sidebar').boundingBox())?.x ?? -1),
      )
      .toBe(0);

    const drawerBox = await page.locator('aside.db-shell-sidebar').boundingBox();
    const scrimBox = await page.locator('.db-shell-scrim').boundingBox();
    if (!drawerBox || !scrimBox) throw new Error('drawer or scrim not laid out');

    // The drawer is capped at 85vw precisely so a dismissable strip of scrim
    // always remains. Assert that invariant, then tap it.
    const uncovered = scrimBox.x + scrimBox.width - (drawerBox.x + drawerBox.width);
    expect(uncovered, 'no tappable scrim left beside the drawer').toBeGreaterThanOrEqual(44);
    await page.locator('.db-shell-scrim').click({
      position: { x: scrimBox.width - uncovered / 2, y: scrimBox.height / 2 },
    });
    await expect(page.locator('.db-shell')).toHaveAttribute('data-db-drawer', 'closed');

    const survived = await page.evaluate(
      () =>
        document.querySelector('.squisq-editor-shell')?.getAttribute('data-identity-probe') ?? null,
    );
    expect(survived, 'the editor node was replaced across a drawer toggle').toBe('original');
  });

  test('gives every shell control a reachable touch target', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.startsWith('ipad'), 'phone projects only');
    await page.goto('/');
    const shell = page.locator('.db-shell');
    await expect(shell).toBeVisible();
    // Visibility can win the first WebKit frame before the form-factor effect
    // stamps the shell. Measuring in that frame reads the fine-pointer token
    // defaults (28px) rather than the settled coarse-pointer hit areas.
    await expect(shell).toHaveAttribute('data-db-pointer', 'coarse');

    const undersized = await page.evaluate(() => {
      const selectors = ['.db-tree-row', '.db-tree-more', '.db-explorer-btn'];
      const offenders: string[] = [];
      for (const selector of selectors) {
        for (const element of document.querySelectorAll<HTMLElement>(selector)) {
          const style = getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          const box = element.getBoundingClientRect();
          if (box.width === 0 && box.height === 0) continue;
          // ::after widens the hit area without moving the glyph, so measure
          // the union of the two.
          const after = getComputedStyle(element, '::after');
          const inset = Number.parseFloat(after.insetBlockStart || '0');
          const effectiveHeight = box.height - (Number.isFinite(inset) ? inset * 2 : 0);
          const effectiveWidth = box.width - (Number.isFinite(inset) ? inset * 2 : 0);
          if (effectiveHeight < 44 || effectiveWidth < 24) {
            offenders.push(
              `${selector} ${Math.round(effectiveWidth)}x${Math.round(effectiveHeight)}`,
            );
          }
        }
      }
      return offenders;
    });
    expect(undersized).toEqual([]);
  });

  test('keeps every text input above the iOS zoom threshold', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.startsWith('ipad'), 'phone projects only');
    await page.goto('/');
    await expect(page.locator('.db-shell')).toBeVisible();
    await page.getByRole('button', { name: /Switch workspace/ }).click();
    await page.getByRole('button', { name: 'New Workspace' }).click();
    await expect(page.getByLabel('Workspace name')).toBeVisible();

    const fontSize = await page
      .getByLabel('Workspace name')
      .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
    // Below 16px, focusing the field makes iOS Safari zoom the whole page and
    // it never zooms back out.
    expect(fontSize).toBeGreaterThanOrEqual(16);
  });

  test('never scrolls horizontally', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.startsWith('ipad'), 'phone projects only');
    await openWelcomeDocument(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

test.describe('adaptive shell on a tablet', () => {
  test.skip(({ isMobile }) => isMobile !== true, 'touch-emulating projects only');

  test('splits in landscape and drawers in portrait', async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith('ipad'), 'iPad projects only');
    await openWelcomeDocument(page);

    const attributes = await layoutAttributes(page);
    expect(attributes.pointer).toBe('coarse');

    if (testInfo.project.name.includes('landscape')) {
      // 1194px wide: expanded, so both panes share the row and the resizer is
      // available.
      expect(attributes.width).toBe('expanded');
      expect(attributes.formFactor).toBe('tablet-landscape');
      expect(attributes.layout).toBe('split-pane');
      await expect(page.locator('.db-shell-sidebar-resizer')).toBeVisible();
      await expect(page.locator('.db-shell-scrim')).toHaveCount(0);
    } else {
      // 834px wide: above the 800px split floor but a touch device, so the
      // sidebar overlays rather than competing with the editor for width.
      expect(attributes.width).toBe('medium');
      expect(attributes.formFactor).toBe('tablet-portrait');
      expect(attributes.layout).toBe('single-pane');
      await expect(page.locator('.db-shell-sidebar-resizer')).toHaveCount(0);
    }
  });

  test('survives rotation without replacing the editor', async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith('ipad'), 'iPad projects only');
    await openWelcomeDocument(page);

    await page.evaluate(() => {
      const editor = document.querySelector('.squisq-editor-shell');
      if (!editor) throw new Error('editor shell not found');
      (editor as HTMLElement).dataset.identityProbe = 'original';
    });

    const portrait = { width: 834, height: 1194 };
    const landscape = { width: 1194, height: 834 };
    const start = page.viewportSize() ?? portrait;
    const target = start.width > start.height ? portrait : landscape;

    await page.setViewportSize(target);
    await expect
      .poll(async () => (await layoutAttributes(page)).layout)
      .toBe(target.width > target.height ? 'split-pane' : 'single-pane');

    const survived = await page.evaluate(
      () =>
        document.querySelector('.squisq-editor-shell')?.getAttribute('data-identity-probe') ?? null,
    );
    expect(survived, 'rotating the device replaced the editor node').toBe('original');
  });
});
