import type { Page } from '@playwright/test';
import { expect, test } from './helpers/test.js';

/**
 * Settings sections on the touch-emulating device projects: phones and
 * portrait tablets pick a section from a dropdown, while a landscape tablet
 * keeps the tab rail a desktop window gets.
 */

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
    await expect(shell).toHaveAttribute('data-db-drawer', 'closed');
    await page.getByRole('button', { name: 'Show file list' }).click();
    await expect(shell).toHaveAttribute('data-db-drawer', 'open');
  }
  await page.locator('.db-app-menu-btn').click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('Settings sections on touch devices', () => {
  test.skip(({ isMobile }) => isMobile !== true, 'touch-emulating projects only');

  test('use a dropdown on phones and portrait tablets and tabs in landscape', async ({
    page,
  }, testInfo) => {
    const dialog = await openSettings(page);
    const picker = dialog.getByRole('combobox', { name: 'Settings section' });

    if (testInfo.project.name.includes('landscape')) {
      await expect(dialog.getByRole('tablist', { name: 'Settings sections' })).toBeVisible();
      await expect(picker).toHaveCount(0);
      await dialog.getByRole('tab', { name: 'Device integration', exact: true }).click();
    } else {
      await expect(dialog.getByRole('tablist')).toHaveCount(0);
      await expect(picker).toHaveValue('appearance');
      await picker.selectOption({ label: 'Device integration' });
    }
    await expect(dialog.getByRole('group', { name: 'Version history' })).toBeVisible();
    await expect(dialog.getByRole('group', { name: 'Theme' })).toBeHidden();

    const layout = await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        insideViewport:
          rect.left >= 0 &&
          rect.top >= 0 &&
          rect.right <= window.innerWidth &&
          rect.bottom <= window.innerHeight,
        scrollsSideways: element.scrollWidth > element.clientWidth,
      };
    });
    expect(layout.insideViewport).toBe(true);
    expect(layout.scrollsSideways).toBe(false);
  });
});
