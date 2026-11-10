import type { Page } from '@playwright/test';
import { expect, test } from './helpers/test.js';

/**
 * The Write / Source / Slideshow tabs share a phone's top row with the files
 * button. At 360px, or with Android's larger system text, the full labels and
 * their ▾ buttons ran off the right edge. On a phone-width toolbar Source
 * becomes its </> icon and Slideshow reads "Slides"; a tablet keeps the full
 * labels. Every tab keeps its full name for assistive technology.
 */

async function openWelcomeDocument(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.db-shell')).toBeVisible();
  const tour = page.getByRole('button', { name: 'Tour the welcome document' });
  const startWriting = page.locator('.db-welcome-gateway-cta');
  await expect(tour.or(startWriting).first()).toBeVisible({ timeout: 30_000 });
  await ((await tour.count()) > 0 ? tour : startWriting).click();
  await expect(page.locator('.squisq-toolbar-view-tabs')).toBeVisible({ timeout: 30_000 });
  const shell = page.locator('.db-shell');
  if ((await shell.getAttribute('data-db-layout')) === 'single-pane') {
    await expect(shell).toHaveAttribute('data-db-drawer', 'closed');
  }
}

/** Tabs and ▾ buttons that reach past the viewport's right edge. */
async function overflowingTabControls(page: Page): Promise<string[]> {
  return page.locator('.squisq-toolbar-view-tabs').evaluate((tabs) => {
    const right = document.documentElement.clientWidth;
    return [...tabs.querySelectorAll<HTMLElement>('[role="tab"], .squisq-view-mode-trigger')]
      .filter((control) => control.getBoundingClientRect().right > right + 0.5)
      .map((control) => control.getAttribute('aria-label') ?? control.textContent ?? '');
  });
}

test.describe('Editor view tabs on touch devices', () => {
  test.skip(({ isMobile }) => isMobile !== true, 'touch-emulating projects only');

  test('keep their full names whatever they show', async ({ page }) => {
    await openWelcomeDocument(page);
    for (const name of ['Write', 'Source', 'Slideshow']) {
      await expect(page.getByRole('tab', { name, exact: true })).toBeVisible();
    }
  });

  test('fit a phone row at any width and text size', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.startsWith('ipad'), 'phone projects only');
    await openWelcomeDocument(page);
    const source = page.getByRole('tab', { name: 'Source', exact: true });
    const slideshow = page.getByRole('tab', { name: 'Slideshow', exact: true });

    const device = page.viewportSize()!;
    for (const width of [device.width, 360]) {
      await page.setViewportSize({ width, height: device.height });
      await expect(source.locator('.squisq-toolbar-view-tab-icon')).toBeVisible();
      await expect(source.locator('.squisq-toolbar-view-tab-label--long')).toBeHidden();
      await expect(slideshow).toHaveText('Slides');
      // Android scales every font to the system text size and leaves padding
      // alone; scaling the tabs' font sizes reproduces that here.
      for (const scale of [1, 1.15, 1.3]) {
        await page.locator('.db-shell').evaluate((shell, factor) => {
          for (const node of shell.querySelectorAll<HTMLElement>(
            '.squisq-toolbar-view-tab, .squisq-view-mode-trigger',
          )) {
            node.style.fontSize = `${13 * factor}px`;
          }
        }, scale);
        expect(await overflowingTabControls(page), `${width}px at ${scale}x text`).toEqual([]);
      }
    }
  });

  test('keep the full labels on a tablet', async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith('ipad'), 'tablet projects only');
    await openWelcomeDocument(page);
    const source = page.getByRole('tab', { name: 'Source', exact: true });
    await expect(source.locator('.squisq-toolbar-view-tab-label--long')).toBeVisible();
    await expect(source.locator('.squisq-toolbar-view-tab-icon')).toBeHidden();
    await expect(page.getByRole('tab', { name: 'Slideshow', exact: true })).toHaveText(
      'Slideshow',
    );
  });
});
