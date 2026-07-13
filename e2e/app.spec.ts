import { test, expect } from '@playwright/test';
import { openInitializedSite } from './helpers/site.js';

test.describe('DocBlocks App', () => {
  test.beforeEach(async ({ page }) => {
    await openInitializedSite(page);
  });

  test('loads and shows the shell', async ({ page }) => {
    const shell = page.locator('.db-shell');
    await expect(shell).toBeVisible();
    await expect(page).toHaveTitle('aboutDocBlocks - DocBlocks');
  });

  test('has a sidebar with workspace picker', async ({ page }) => {
    const sidebar = page.locator('.db-shell-sidebar');
    await expect(sidebar).toBeVisible();

    const picker = page.locator('.db-workspace-picker-btn');
    await expect(picker).toBeVisible();
  });

  test('shows the document pane when the sidebar is dragged closed', async ({ page }) => {
    const gateway = page.locator('.db-welcome-gateway');
    await expect(gateway).toBeVisible({ timeout: 10_000 });
    await page.locator('.db-welcome-gateway-cta').click();

    const editor = page.locator('[contenteditable="true"]').first();
    await expect(editor).toBeVisible({ timeout: 10_000 });

    const resizer = page.getByRole('separator', { name: 'Resize sidebar' });
    const box = await resizer.boundingBox();
    if (!box) throw new Error('Sidebar resizer not found');

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(100, box.y + box.height / 2);
    await page.mouse.up();

    await expect(page.locator('.db-shell-sidebar')).not.toBeVisible();
    await expect(editor).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show file list' })).toBeVisible();
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
    const newFileIcon = buttons.nth(0).locator('.fa-file-circle-plus');
    await expect(newFileIcon).toBeVisible();
    await expect(newFileIcon).toHaveCSS('font-family', /Font Awesome/);
    await expect(buttons.nth(1).locator('.fa-folder-plus')).toBeVisible();
    await expect(buttons.nth(2).locator('.fa-arrows-rotate')).toBeVisible();

    await expect(page.locator('.db-ws-settings-btn .fa-gear')).toBeVisible();
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

    const statusItem = page.locator('.squisq-status-item').first();
    await expect(statusItem).toBeVisible();
    const [linkBox, statusBox] = await Promise.all([link.boundingBox(), statusItem.boundingBox()]);
    if (!linkBox || !statusBox) throw new Error('Footer alignment elements not found');

    const linkCenter = linkBox.y + linkBox.height / 2;
    const statusCenter = statusBox.y + statusBox.height / 2;
    expect(linkCenter).toBe(statusCenter);
  });
});

test.describe('File operations', () => {
  test.beforeEach(async ({ page }) => {
    await openInitializedSite(page);
  });

  test('can create a new file', async ({ page }) => {
    const newFileBtn = page.locator('.db-explorer-btn').first();
    await newFileBtn.click();

    const input = page.locator('.db-new-item-input');
    await expect(input).toBeVisible();
    await input.fill('test-doc');

    await page.locator('.db-new-item-add').click();

    // File should appear in tree
    const treeRow = page.locator('.db-tree-row', { hasText: 'test-doc' });
    await expect(treeRow).toBeVisible({ timeout: 5_000 });
  });

  test('can create a file and see editor', async ({ page }) => {
    const newFileBtn = page.locator('.db-explorer-btn').first();
    await newFileBtn.click();

    const input = page.locator('.db-new-item-input');
    await input.fill('edit-me');
    await page.locator('.db-new-item-add').click();

    // Click the file to open it
    const treeRow = page.locator('.db-tree-row', { hasText: 'edit-me' });
    await expect(treeRow).toBeVisible({ timeout: 5_000 });
    await treeRow.click();

    // Editor should appear (empty state should be gone)
    await expect(page.locator('.db-shell-empty')).not.toBeVisible();
    await expect(page).toHaveTitle('edit-me - DocBlocks');
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

  test('can drag a file into a folder and back to the workspace root', async ({ page }) => {
    const buttons = page.locator('.db-explorer-btn');

    await buttons.nth(0).click();
    await page.locator('.db-new-item-input').fill('drag-me');
    await page.locator('.db-new-item-add').click();

    await buttons.nth(1).click();
    await page.locator('.db-new-item-input').fill('drop-here');
    await page.locator('.db-new-item-add').click();

    const fileRow = page.locator('.db-tree-row', { hasText: 'drag-me' });
    const folderRow = page.locator('.db-tree-row', { hasText: 'drop-here' });
    await fileRow.click();
    await fileRow.dragTo(folderRow);

    const folderNode = folderRow.locator('..');
    await expect(
      folderNode.locator('.db-tree-children .db-tree-row', { hasText: 'drag-me' }),
    ).toBeVisible();
    await expect
      .poll(() => decodeURIComponent(new URL(page.url()).hash))
      .toContain('/drop-here/drag-me.md');

    await fileRow.dragTo(page.locator('.db-tree'), { targetPosition: { x: 8, y: 200 } });
    await expect(
      folderNode.locator('.db-tree-children .db-tree-row', { hasText: 'drag-me' }),
    ).toHaveCount(0);
    await expect(
      page.locator('.db-tree > .db-tree-node > .db-tree-row', { hasText: 'drag-me' }),
    ).toBeVisible();
    await expect.poll(() => decodeURIComponent(new URL(page.url()).hash)).toMatch(/\/drag-me\.md$/);
  });
});

test.describe('Folder context menu theming', () => {
  test('uses DocBlocks colors when portaled outside the dark shell', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('docblocks:themePreference', 'dark');
    });
    await openInitializedSite(page);
    await expect(page.locator('.db-shell[data-theme="dark"]')).toBeVisible({ timeout: 10_000 });

    await page.locator('.db-explorer-btn').nth(1).click();
    await page.locator('.db-new-item-input').fill('menu-theme-folder');
    await page.locator('.db-new-item-add').click();

    const treeRow = page.locator('.db-tree-row', { hasText: 'menu-theme-folder' });
    await expect(treeRow).toBeVisible({ timeout: 5_000 });
    await treeRow.hover();
    await treeRow.locator('.db-tree-more').click();

    const menu = page.locator('.db-tree-context');
    await expect(menu).toBeVisible();

    const colors = await menu.evaluate((element) => {
      const resolveColor = (property: string): string => {
        const probe = document.createElement('span');
        probe.style.color = `var(${property})`;
        document.body.appendChild(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      };

      const normalItem = element.querySelector<HTMLElement>('.db-tree-context-item');
      const dangerItem = element.querySelector<HTMLElement>('.db-tree-context-item--danger');
      return {
        background: getComputedStyle(element).backgroundColor,
        normalText: normalItem ? getComputedStyle(normalItem).color : '',
        dangerText: dangerItem ? getComputedStyle(dangerItem).color : '',
        expectedBackground: resolveColor('--db-bg'),
        expectedNormalText: resolveColor('--db-text-secondary'),
        expectedDangerText: resolveColor('--db-danger'),
      };
    });

    expect(colors.background).toBe(colors.expectedBackground);
    expect(colors.normalText).toBe(colors.expectedNormalText);
    expect(colors.dangerText).toBe(colors.expectedDangerText);
  });
});

test.describe('Welcome gateway', () => {
  test('first run shows the gateway and Start writing opens the editor', async ({ page }) => {
    await openInitializedSite(page);

    // Fresh storage → the welcome doc auto-opens in Play view with the gateway
    const gateway = page.locator('.db-welcome-gateway');
    await expect(gateway).toBeVisible({ timeout: 10_000 });

    await page.locator('.db-welcome-gateway-cta').click();
    await expect(gateway).not.toBeVisible();

    // The same document is now editable
    await expect(page.locator('[contenteditable="true"]').first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test('dismissal persists across reload', async ({ page }) => {
    await openInitializedSite(page);

    const gateway = page.locator('.db-welcome-gateway');
    await expect(gateway).toBeVisible({ timeout: 10_000 });
    await page.locator('.db-welcome-gateway-dismiss').click();
    await expect(gateway).not.toBeVisible();

    await page.reload();
    await expect(page.locator('.db-shell')).toBeVisible({ timeout: 10_000 });
    // Give the shell a moment to auto-select the welcome doc, then confirm
    // the gateway stayed dismissed.
    await page.waitForTimeout(1_500);
    await expect(gateway).not.toBeVisible();
  });
});

test.describe('Squisq overflow menu theming', () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test('uses DocBlocks dark-theme surfaces and text colors', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('docblocks:themePreference', 'dark');
    });
    await openInitializedSite(page);
    await expect(page.locator('.db-shell[data-theme="dark"]')).toBeVisible({ timeout: 10_000 });

    await page.locator('.db-welcome-gateway-cta').click();
    await expect(page.locator('[contenteditable="true"]').first()).toBeVisible({
      timeout: 10_000,
    });

    const trigger = page.locator('.squisq-toolbar-overflow-trigger');
    await expect(trigger).toBeVisible();
    await trigger.click();

    const menu = page.locator('.squisq-toolbar-overflow-menu');
    await expect(menu).toBeVisible();
    await expect(menu.locator('.squisq-template-picker-trigger')).toBeVisible();

    const colors = await menu.evaluate((element) => {
      const shell = document.querySelector<HTMLElement>('.db-shell');
      if (!shell) throw new Error('DocBlocks shell not found');

      const probe = document.createElement('div');
      probe.style.cssText = [
        'position:absolute',
        'visibility:hidden',
        'background:var(--db-bg)',
        'border:1px solid var(--db-border)',
        'color:var(--db-text-secondary)',
      ].join(';');
      shell.appendChild(probe);

      const menuStyle = getComputedStyle(element);
      const probeStyle = getComputedStyle(probe);
      const firstItem = element.querySelector<HTMLElement>(
        '.squisq-toolbar-overflow-item:not(.squisq-toolbar-overflow-item--active):not(.squisq-toolbar-overflow-item--danger)',
      );
      const picker = element.querySelector<HTMLElement>('.squisq-template-picker-trigger');

      const result = {
        menuBackground: menuStyle.backgroundColor,
        menuBorder: menuStyle.borderTopColor,
        itemColor: firstItem ? getComputedStyle(firstItem).color : '',
        pickerBorder: picker ? getComputedStyle(picker).borderTopColor : '',
        expectedBackground: probeStyle.backgroundColor,
        expectedBorder: probeStyle.borderTopColor,
        expectedText: probeStyle.color,
      };
      probe.remove();
      return result;
    });

    expect(colors.menuBackground).toBe(colors.expectedBackground);
    expect(colors.menuBorder).toBe(colors.expectedBorder);
    expect(colors.itemColor).toBe(colors.expectedText);
    expect(colors.pickerBorder).toBe(colors.expectedBorder);
  });
});

test.describe('Workspace picker', () => {
  test.beforeEach(async ({ page }) => {
    await openInitializedSite(page);
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
    const newWorkspace = dropdown.getByRole('button', { name: 'New Workspace' });
    await expect(newWorkspace).toBeVisible();
    await expect(newWorkspace.locator('.fa-folder-plus')).toBeVisible();
  });

  test('dropdown closes on outside click', async ({ page }) => {
    await page.locator('.db-workspace-picker-btn').click();
    await expect(page.locator('.db-workspace-dropdown')).toBeVisible();

    await page.locator('.db-explorer-title').click();
    await expect(page.locator('.db-workspace-dropdown')).not.toBeVisible();
  });
});
