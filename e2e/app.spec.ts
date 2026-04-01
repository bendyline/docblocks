import { test, expect } from '@playwright/test';

test.describe('DocBlocks App', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Wait for the shell to initialize (workspace + welcome file may load)
    await expect(page.locator('.db-shell')).toBeVisible({ timeout: 10_000 });
  });

  test('loads and shows the shell', async ({ page }) => {
    const shell = page.locator('.db-shell');
    await expect(shell).toBeVisible();
  });

  test('has a sidebar with workspace picker', async ({ page }) => {
    const sidebar = page.locator('.db-shell-sidebar');
    await expect(sidebar).toBeVisible();

    const picker = page.locator('.db-workspace-picker-btn');
    await expect(picker).toBeVisible();
  });

  test('shows the app menu button', async ({ page }) => {
    const menuBtn = page.locator('.db-app-menu-btn');
    await expect(menuBtn).toBeVisible();
  });

  test('app menu opens and shows About', async ({ page }) => {
    await page.locator('.db-app-menu-btn').click();
    const dropdown = page.locator('.db-app-menu-dropdown');
    await expect(dropdown).toBeVisible();

    await expect(dropdown.getByText('About')).toBeVisible();
  });

  test('app menu closes on outside click', async ({ page }) => {
    await page.locator('.db-app-menu-btn').click();
    await expect(page.locator('.db-app-menu-dropdown')).toBeVisible();

    // Click outside the menu
    await page.locator('.db-shell-sidebar-footer').click();
    await expect(page.locator('.db-app-menu-dropdown')).not.toBeVisible();
  });

  test('shows file explorer with FILES heading', async ({ page }) => {
    const title = page.locator('.db-explorer-title');
    await expect(title).toBeVisible();
    await expect(title).toHaveText('Files');
  });

  test('has toolbar with new file and new folder buttons', async ({ page }) => {
    const toolbar = page.locator('.db-explorer-toolbar');
    await expect(toolbar).toBeVisible();

    const buttons = toolbar.locator('.db-explorer-btn');
    await expect(buttons).toHaveCount(3); // +F, +D, refresh
  });

  test('shows Terms of Use link in footer', async ({ page }) => {
    const footer = page.locator('.db-shell-sidebar-footer');
    await expect(footer).toBeVisible();

    const link = footer.locator('a');
    await expect(link).toHaveText('Terms of Use');
    await expect(link).toHaveAttribute(
      'href',
      'https://github.com/bendyline/docblocks/blob/main/LICENSE',
    );
  });
});

test.describe('File operations', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.db-shell')).toBeVisible({ timeout: 10_000 });
    // Wait for the file explorer to be ready
    await expect(page.locator('.db-explorer-toolbar')).toBeVisible({ timeout: 10_000 });
  });

  test('can create a new file', async ({ page }) => {
    const newFileBtn = page.locator('.db-explorer-btn').first();
    await newFileBtn.click();

    const input = page.locator('.db-new-item-input');
    await expect(input).toBeVisible();
    await input.fill('test-doc');

    await page.locator('.db-new-item-add').click();

    // File should appear in tree
    const treeRow = page.locator('.db-tree-row', { hasText: 'test-doc.md' });
    await expect(treeRow).toBeVisible({ timeout: 5_000 });
  });

  test('can create a file and see editor', async ({ page }) => {
    const newFileBtn = page.locator('.db-explorer-btn').first();
    await newFileBtn.click();

    const input = page.locator('.db-new-item-input');
    await input.fill('edit-me');
    await page.locator('.db-new-item-add').click();

    // Click the file to open it
    const treeRow = page.locator('.db-tree-row', { hasText: 'edit-me.md' });
    await expect(treeRow).toBeVisible({ timeout: 5_000 });
    await treeRow.click();

    // Editor should appear (empty state should be gone)
    await expect(page.locator('.db-shell-empty')).not.toBeVisible();
  });

  test('can create a folder', async ({ page }) => {
    const buttons = page.locator('.db-explorer-btn');
    await buttons.nth(1).click();

    const input = page.locator('.db-new-item-input');
    await expect(input).toBeVisible();
    await input.fill('my-folder');
    await page.locator('.db-new-item-add').click();

    const treeRow = page.locator('.db-tree-row', { hasText: 'my-folder' });
    await expect(treeRow).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('Workspace picker', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.db-shell')).toBeVisible({ timeout: 10_000 });
  });

  test('shows current workspace', async ({ page }) => {
    const picker = page.locator('.db-workspace-picker-btn');
    await expect(picker).toBeVisible();
    await expect(picker).toContainText(/(My Documents|notes|No workspace)/);
  });

  test('opens workspace dropdown', async ({ page }) => {
    await page.locator('.db-workspace-picker-btn').click();
    const dropdown = page.locator('.db-workspace-dropdown');
    await expect(dropdown).toBeVisible();
  });

  test('dropdown has new workspace option', async ({ page }) => {
    await page.locator('.db-workspace-picker-btn').click();
    const dropdown = page.locator('.db-workspace-dropdown');
    await expect(dropdown.getByText('New Workspace')).toBeVisible();
  });

  test('dropdown closes on outside click', async ({ page }) => {
    await page.locator('.db-workspace-picker-btn').click();
    await expect(page.locator('.db-workspace-dropdown')).toBeVisible();

    await page.locator('.db-explorer-title').click();
    await expect(page.locator('.db-workspace-dropdown')).not.toBeVisible();
  });
});
