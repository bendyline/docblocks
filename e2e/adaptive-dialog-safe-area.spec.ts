import type { Locator, Page } from '@playwright/test';
import { expect, test } from './helpers/test.js';

/**
 * Dialogs and the safe areas on the touch-emulating device projects. No dialog
 * reaches under a notch, the status bar or the home indicator. On a phone the
 * wide and full dialogs fill the window instead of floating, and their header
 * runs up under the status bar with its title just below it; the default-size
 * dialogs stay cards, as every dialog does on a tablet.
 *
 * No emulated browser reports a safe area, so the tests write a notched
 * iPhone's insets over the shell's `--db-safe-*` tokens, which dialogs inherit
 * from <html>.
 */

const SAFE_TOP = 47;
const SAFE_BOTTOM = 34;

async function emulateNotch(page: Page) {
  await page.addInitScript(
    ([top, bottom]) => {
      const apply = () => {
        const root = document.documentElement.style;
        root.setProperty('--db-safe-top', `${top}px`);
        root.setProperty('--db-safe-bottom', `${bottom}px`);
      };
      // Init scripts can run before the document has a root element.
      if (document.documentElement) apply();
      else document.addEventListener('DOMContentLoaded', apply, { once: true });
    },
    [SAFE_TOP, SAFE_BOTTOM],
  );
}

async function openSettings(page: Page) {
  await page.goto('/');
  const shell = page.locator('.db-shell');
  await expect(shell).toBeVisible();
  // Which first-run gateway appears depends on the layout; wait for either.
  const tour = page.getByRole('button', { name: 'Tour the welcome document' });
  const startWriting = page.locator('.db-welcome-gateway-cta');
  await expect(tour.or(startWriting).first()).toBeVisible({ timeout: 30_000 });
  await ((await tour.count()) > 0 ? tour : startWriting).click();
  await expect(page.locator('.squisq-toolbar')).toBeVisible({ timeout: 30_000 });
  // In single-pane the app menu lives in the drawer.
  if ((await shell.getAttribute('data-db-layout')) === 'single-pane') {
    await page.getByRole('button', { name: 'Show file list' }).click();
    await expect(shell).toHaveAttribute('data-db-drawer', 'open');
  }
  await page.locator('.db-app-menu-btn').click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

async function expectCardInsideSafeAreas(page: Page, dialog: Locator) {
  const viewport = page.viewportSize()!;
  const panel = await boxOf(dialog);
  expect(panel.x).toBeGreaterThan(0);
  expect(panel.x + panel.width).toBeLessThan(viewport.width);
  expect(panel.y).toBeGreaterThanOrEqual(SAFE_TOP + 16);
  expect(panel.y + panel.height).toBeLessThanOrEqual(viewport.height - SAFE_BOTTOM - 16);
}

test.describe('Dialogs and the safe areas on touch devices', () => {
  test.skip(({ isMobile }) => isMobile !== true, 'touch-emulating projects only');

  test.beforeEach(async ({ page }) => {
    await emulateNotch(page);
  });

  test('a wide dialog fills a phone window, its header under the status bar', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name.startsWith('ipad'), 'phone projects only');
    const dialog = await openSettings(page);
    const viewport = page.viewportSize()!;

    expect(await boxOf(dialog)).toEqual({
      x: 0,
      y: 0,
      width: viewport.width,
      height: viewport.height,
    });
    // The header's top edge meets the top of the screen…
    const header = await boxOf(dialog.locator('.db-dialog-header'));
    expect(header.y).toBe(0);
    expect(header.width).toBe(viewport.width);
    // …while its title and close button sit below the status bar.
    for (const part of [
      dialog.locator('.db-dialog-title'),
      dialog.getByRole('button', { name: 'Close', exact: true }),
    ]) {
      expect((await boxOf(part)).y).toBeGreaterThanOrEqual(SAFE_TOP);
    }
    // The content ends above the home indicator.
    const body = await boxOf(dialog.locator('.db-dialog-body'));
    expect(body.y + body.height).toBeLessThanOrEqual(viewport.height - SAFE_BOTTOM);

    // With the on-screen keyboard up, the sheet ends at its top edge.
    const keyboardTop = Math.round(viewport.height / 2);
    await page.evaluate((inset) => {
      document.documentElement.style.setProperty('--db-keyboard-inset', `${inset}px`);
    }, viewport.height - keyboardTop);
    const raised = await boxOf(dialog);
    expect(raised.y + raised.height).toBe(keyboardTop);

    await testInfo.attach('settings sheet', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  });

  test('a wide dialog stays a card inside the safe areas on a tablet', async ({
    page,
  }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith('ipad'), 'tablet projects only');
    await expectCardInsideSafeAreas(page, await openSettings(page));
  });

  test('a default-size dialog stays a card inside the safe areas', async ({ page }) => {
    // The installed-app "New document" shortcut opens the dialog on launch.
    await page.goto('/?action=new');
    const dialog = page.getByRole('dialog', { name: 'New document' });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expectCardInsideSafeAreas(page, dialog);
  });
});
