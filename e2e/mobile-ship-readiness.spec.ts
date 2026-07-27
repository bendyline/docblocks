import { test, expect } from '@playwright/test';

test.describe('mobile web-editor ship readiness', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('welcomes first-time users in the file pane and keeps every command reachable', async ({
    page,
  }) => {
    await page.goto('/');

    await expect(page.locator('.db-shell')).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Workspace and files' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Welcome to DocBlocks' })).toBeVisible();
    await expect(page.getByRole('main', { name: 'Document editor' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Tour the welcome document' }).click();
    await expect(page.getByRole('main', { name: 'Document editor' })).toBeVisible();
    await expect(page.locator('.squisq-toolbar')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: 'Show file list' })).toBeVisible();

    const exportAndShare = page.getByRole('button', { name: 'Export and share' });
    await expect(exportAndShare).toBeVisible({ timeout: 20_000 });

    await page.getByRole('tab', { name: 'Write' }).click();
    await expect(page.getByRole('tab', { name: 'Write' })).toHaveAttribute('aria-selected', 'true');

    const clippedControls = await page.locator('.squisq-toolbar button').evaluateAll((buttons) =>
      buttons
        .filter((button) => {
          const style = getComputedStyle(button);
          const rect = button.getBoundingClientRect();
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 &&
            rect.height > 0
          );
        })
        .filter((button) => {
          const rect = button.getBoundingClientRect();
          return rect.left < 0 || rect.right > document.documentElement.clientWidth;
        })
        .map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? ''),
    );
    expect(clippedControls).toEqual([]);

    const moreActions = page.getByRole('button', { name: 'More actions' });
    await moreActions.click();
    await expect(page.getByRole('button', { name: 'Bold (Ctrl+B)' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Insert...' })).toBeVisible();
    const overflowMenu = page.locator('.squisq-toolbar-overflow-menu');
    await expect(overflowMenu).toBeVisible();
    const overflowBounds = await overflowMenu.boundingBox();
    expect(overflowBounds).not.toBeNull();
    expect(overflowBounds!.x).toBeGreaterThanOrEqual(0);
    expect(overflowBounds!.x + overflowBounds!.width).toBeLessThanOrEqual(390);
    await moreActions.click();

    await exportAndShare.click();
    await expect(page.getByRole('menuitem', { name: 'Export document...' })).toBeVisible();
    await expect(
      page.getByRole('menuitem', { name: 'Share link with content embedded...' }),
    ).toBeVisible();

    await exportAndShare.click();
    await page.getByRole('button', { name: 'Show file list' }).click();
    await expect(page.getByRole('complementary', { name: 'Workspace and files' })).toBeVisible();
  });

  test('keeps CLI installation steps separate and usable at phone width', async ({ page }) => {
    await page.goto('/cli/');

    const commands = page.locator('.install-commands .install-command');
    await expect(commands).toHaveCount(2);
    await expect(commands.nth(0)).toHaveText('npm install -g @bendyline/docblocks-cli');
    await expect(commands.nth(1)).toHaveText('docblocks --help');

    const layout = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      commands: [...document.querySelectorAll<HTMLElement>('.install-command')].map((command) => ({
        clientWidth: command.clientWidth,
        scrollWidth: command.scrollWidth,
      })),
    }));
    expect(layout.overflow).toBeLessThanOrEqual(8);
    expect(layout.commands).toHaveLength(2);
    expect(layout.commands.every(({ clientWidth }) => clientWidth > 0)).toBe(true);
  });
});

test.describe('workspace landing experience', () => {
  test('names a new workspace before creation and presents neutral next actions', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('.db-shell')).toBeVisible();

    await page.getByRole('button', { name: /Switch workspace/ }).click();
    await page.getByRole('button', { name: 'New Workspace' }).click();

    const nameInput = page.getByLabel('Workspace name');
    await expect(nameInput).toBeVisible();
    await nameInput.fill('Customer launch notes');
    await page.getByRole('button', { name: 'Create', exact: true }).click();

    await expect(
      page.getByRole('button', { name: 'Switch workspace, current: Customer launch notes' }),
    ).toBeVisible();
    const landing = page.locator('.db-workspace-empty-content');
    await expect(landing.getByRole('heading', { name: 'Customer launch notes' })).toBeVisible();
    await expect(
      landing.getByText('Choose a Markdown document from the sidebar, or create a new one.'),
    ).toBeVisible();
    await expect(landing.getByRole('button', { name: 'New document' })).toBeVisible();
    await expect(landing).not.toContainText(/\bis ready\b/i);
    await expect(landing).not.toContainText(/create your first/i);
    await expect(
      page
        .locator('.db-workspace-empty-actions')
        .getByRole('button', { name: 'New folder', exact: true }),
    ).toBeVisible();
  });
});
