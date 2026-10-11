import { expect, test } from './helpers/test.js';

/**
 * Workspace search inside the phone drawer. Runs on the touch-emulating
 * device projects, where the sidebar is a drawer over the editor.
 */
test.describe('workspace search in the phone drawer', () => {
  test.skip(({ isMobile }) => isMobile !== true, 'touch-emulating projects only');

  test('opens a match into the editor and keeps the results for the next visit', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name.startsWith('ipad'), 'phone projects only');
    await page.goto('/');
    const tour = page.getByRole('button', { name: 'Tour the welcome document' });
    const startWriting = page.locator('.db-welcome-gateway-cta');
    await expect(tour.or(startWriting).first()).toBeVisible({ timeout: 30_000 });
    await ((await tour.count()) > 0 ? tour : startWriting).click();
    const shell = page.locator('.db-shell');
    await expect(shell).toHaveAttribute('data-db-drawer', 'closed', { timeout: 30_000 });

    await page.getByRole('button', { name: 'Show file list' }).click();
    await expect(shell).toHaveAttribute('data-db-drawer', 'open');
    await page.getByRole('button', { name: 'Search workspace' }).click();

    const input = page.getByRole('searchbox', { name: 'Search workspace' });
    await expect(input).toBeVisible();
    await input.fill('DocBlocks');
    const firstLine = page
      .getByRole('tree', { name: 'Search results' })
      .locator('.db-search-line')
      .first();
    await expect(firstLine).toBeVisible({ timeout: 20_000 });
    await firstLine.click();
    await expect(shell).toHaveAttribute('data-db-drawer', 'closed');

    await page.getByRole('button', { name: 'Show file list' }).click();
    await expect(shell).toHaveAttribute('data-db-drawer', 'open');
    await expect(input).toHaveValue('DocBlocks');
    await expect(firstLine).toBeVisible();
  });
});
