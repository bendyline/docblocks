import type { Page } from '@playwright/test';
import { expect, test } from './helpers/test.js';
import { selectUseMode, showSourceView, showWriteView, viewButton } from './helpers/toolbar.js';

/**
 * The view button shares a phone's top row with the files button and the
 * document name. It shows only the view on screen (Write, Source, Slideshow,
 * …) and opens the View menu. At 360px, or with Android's larger system text,
 * the row's view controls used to run off the right edge. On a phone-width
 * toolbar a Use mode shows its short name (Slideshow reads "Slides"); a
 * tablet keeps the full one. The button keeps the full name for assistive
 * technology whatever it shows.
 */

const VIEWS = ['Write', 'Source', 'Slideshow'] as const;
type View = (typeof VIEWS)[number];

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

async function show(page: Page, view: View): Promise<void> {
  if (view === 'Write') await showWriteView(page);
  else if (view === 'Source') await showSourceView(page);
  else await selectUseMode(page, view);
}

/**
 * The top row's controls that reach past the viewport's right edge, or whose
 * visible view name is cut short.
 */
async function overflowingViewControls(page: Page): Promise<string[]> {
  return page.locator('.squisq-toolbar').evaluate((toolbar) => {
    const right = document.documentElement.clientWidth;
    const controls = toolbar.querySelectorAll<HTMLElement>(
      '.db-document-title, .squisq-toolbar-view-tabs, .squisq-toolbar-view-button',
    );
    const past = [...controls]
      .filter((control) => control.getBoundingClientRect().right > right + 0.5)
      .map((control) => control.getAttribute('aria-label') ?? control.className);
    const clipped = [...toolbar.querySelectorAll<HTMLElement>('.squisq-toolbar-view-button-label')]
      .filter((label) => label.offsetWidth > 0 && label.scrollWidth > label.clientWidth)
      .map((label) => `${label.textContent ?? ''} (cut short)`);
    return [...past, ...clipped];
  });
}

/**
 * Android scales every font to the system text size and leaves padding alone;
 * scaling the row's font sizes from their own base reproduces that here.
 */
async function scaleRowText(page: Page, factor: number): Promise<void> {
  await page.locator('.squisq-toolbar').evaluate((toolbar, scale) => {
    for (const node of toolbar.querySelectorAll<HTMLElement>(
      '.squisq-toolbar-view-button, .db-document-title-input',
    )) {
      node.dataset.baseFontSize ??= getComputedStyle(node).fontSize;
      node.style.fontSize = `${parseFloat(node.dataset.baseFontSize) * scale}px`;
    }
  }, factor);
}

test.describe('Editor view button on touch devices', () => {
  test.skip(({ isMobile }) => isMobile !== true, 'touch-emulating projects only');

  test('keeps its full name whatever it shows', async ({ page }) => {
    await openWelcomeDocument(page);
    const button = viewButton(page);
    for (const view of VIEWS) {
      await show(page, view);
      await expect(button).toHaveAccessibleName(`View: ${view}`);
      await expect(button).toBeVisible();
    }
  });

  test('fits a phone row at any width and text size', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.startsWith('ipad'), 'phone projects only');
    await openWelcomeDocument(page);
    const button = viewButton(page);
    const long = button.locator('.squisq-toolbar-view-button-label--long');
    const short = button.locator('.squisq-toolbar-view-button-label--short');

    const device = page.viewportSize()!;
    for (const view of VIEWS) {
      await page.setViewportSize(device);
      await show(page, view);
      for (const width of [device.width, 360]) {
        await page.setViewportSize({ width, height: device.height });
        if (view === 'Slideshow') {
          await expect(short).toHaveText('Slides');
          await expect(short).toBeVisible();
          await expect(long).toBeHidden();
        } else {
          await expect(long).toHaveText(view);
          await expect(long).toBeVisible();
        }
        for (const scale of [1, 1.15, 1.3]) {
          await scaleRowText(page, scale);
          expect(
            await overflowingViewControls(page),
            `${view} at ${width}px and ${scale}x text`,
          ).toEqual([]);
        }
        await scaleRowText(page, 1);
      }
    }
  });

  test('keeps the full labels on a tablet', async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith('ipad'), 'tablet projects only');
    await openWelcomeDocument(page);
    const button = viewButton(page);
    await showSourceView(page);
    await expect(button.locator('.squisq-toolbar-view-button-label--long')).toHaveText('Source');
    await expect(button.locator('.squisq-toolbar-view-button-label--long')).toBeVisible();
    await selectUseMode(page, 'Slideshow');
    await expect(button.locator('.squisq-toolbar-view-button-label--long')).toBeVisible();
    await expect(button.locator('.squisq-toolbar-view-button-label--short')).toBeHidden();
    expect(await overflowingViewControls(page)).toEqual([]);
  });
});
