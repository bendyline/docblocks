import { expect, test } from './helpers/test.js';

/**
 * Home, Tasks and a tasks folder on touch devices: reached from the drawer,
 * shown in the main pane, with a way back to the files, and nothing wider
 * than the screen.
 */
test.describe('Home and tasks on touch devices', () => {
  test.skip(({ isMobile }) => isMobile !== true, 'touch-emulating projects only');

  test('Home opens from the drawer and a tasks board fits the screen', async ({
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
    const places = page.getByRole('navigation', { name: 'Home and lists' });
    await places.getByRole('button', { name: 'Home' }).click();
    await expect(shell).toHaveAttribute('data-db-drawer', 'closed');

    const home = page.getByRole('region', { name: 'Home' });
    await expect(home.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();

    // A tasks folder from Home, then tasks jotted in the drawer's Quick Jot.
    await home.getByRole('button', { name: 'Add a tasks folder' }).click();
    const board = page.getByRole('region', { name: 'Tasks, tasks' });
    await expect(board).toBeVisible();
    await board.getByRole('button', { name: 'Back to files' }).click();
    await expect(shell).toHaveAttribute('data-db-drawer', 'open');
    const quickJot = page.getByRole('region', { name: 'Quick Jot' });
    const field = quickJot.getByLabel('Jot something down');
    const addTask = quickJot.getByRole('button', { name: 'New task from jot', exact: true });
    await expect(addTask).toBeVisible({ timeout: 15_000 });
    for (const text of ['Call Priya tomorrow', 'Book dentist friday']) {
      await field.fill(text);
      await addTask.click();
      await expect(field).toHaveValue('');
    }
    // Making a task leaves the drawer where it was.
    await expect(shell).toHaveAttribute('data-db-drawer', 'open');
    await places.getByRole('button', { name: 'Home' }).click();
    await expect(shell).toHaveAttribute('data-db-drawer', 'closed');
    await expect(home.getByRole('region', { name: 'This week' })).toContainText('Book dentist');

    // The tasks folder's board, from the list of places' Tasks entry and then its folder.
    await home.getByRole('button', { name: 'Back to files' }).click();
    await expect(shell).toHaveAttribute('data-db-drawer', 'open');
    await places.getByRole('button', { name: /^Tasks/ }).click();
    await expect(page.getByRole('region', { name: 'Tasks', exact: true })).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
