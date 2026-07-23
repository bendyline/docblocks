import { test, expect } from '@playwright/test';
import { openInitializedSite } from './helpers/site.js';
import {
  buildSharedDocumentUrl,
  createSharedDocumentArchive,
} from '../packages/react/src/Export/shared-document.js';
import { WELCOME_DOCUMENT_CONTENT } from '../packages/react/src/DocBlocksShell/welcome-document.js';

test.describe('SEO bootstrap shell', () => {
  test('resembles the app chrome before React mounts', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('docblocks:themePreference', 'dark');
    });
    await page.route('**/src/main.tsx*', (route) => route.abort());
    await page.goto('/');

    await expect(page.locator('html')).toHaveAttribute('data-db-theme', 'dark');
    const bootstrap = page.locator('.db-seo-bootstrap');
    const sidebar = page.locator('.db-seo-bootstrap-sidebar');
    const toolbar = page.locator('.db-seo-bootstrap-toolbar');
    const document = page.locator('.db-seo-bootstrap-document');
    await expect(bootstrap).toBeVisible();
    await expect(sidebar).toBeVisible();
    await expect(toolbar).toBeVisible();
    await expect(document.getByRole('heading', { level: 1 })).toHaveText(
      'The Markdown editor that turns one file into anything.',
    );

    const metrics = await bootstrap.evaluate((element) => {
      const sidebar = element.querySelector<HTMLElement>('.db-seo-bootstrap-sidebar');
      const toolbar = element.querySelector<HTMLElement>('.db-seo-bootstrap-toolbar');
      const document = element.querySelector<HTMLElement>('.db-seo-bootstrap-document');
      const headline = document?.querySelector<HTMLElement>('h1');
      if (!sidebar || !toolbar || !document || !headline) {
        throw new Error('Static app-shell landmarks were not found');
      }
      const sidebarBox = sidebar.getBoundingClientRect();
      const toolbarBox = toolbar.getBoundingClientRect();
      const documentBox = document.getBoundingClientRect();
      return {
        display: getComputedStyle(element).display,
        sidebarWidth: Math.round(sidebarBox.width),
        toolbarHeight: Math.round(toolbarBox.height),
        documentStartsAfterSidebar: documentBox.left >= sidebarBox.right,
        background: getComputedStyle(element).backgroundColor,
        headlineFontSize: getComputedStyle(headline).fontSize,
      };
    });

    expect(metrics.display).toBe('grid');
    expect(metrics.sidebarWidth).toBe(260);
    expect(metrics.toolbarHeight).toBe(48);
    expect(metrics.documentStartsAfterSidebar).toBe(true);
    expect(metrics.background).toBe('rgb(26, 24, 18)');
    expect(metrics.headlineFontSize).toBe('16px');
  });
});

test.describe('Static product routes', () => {
  test('serves a directory index without exposing index.html in the URL', async ({ page }) => {
    await page.goto('/desktop/?source=e2e');

    await expect(page).toHaveURL(/\/desktop\/\?source=e2e$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'Your Markdown. Your folders.',
    );
  });
});

test.describe('DocBlocks App', () => {
  test.beforeEach(async ({ page }) => {
    await openInitializedSite(page);
  });

  test('loads and shows the shell', async ({ page }) => {
    const shell = page.locator('.db-shell');
    await expect(shell).toBeVisible();
    await expect(page).toHaveTitle('DocBlocks — Local-First Markdown Editor');
    await expect(page.locator('main.db-shell-editor-area')).toBeVisible();
  });

  test('renders Mermaid diagrams through the Vite dev server', async ({ page }) => {
    const archive = await createSharedDocumentArchive(
      '# Mermaid diagram\n\n```mermaid\ngraph TD\n  A[DocBlocks] --> B[Squisq]\n```\n',
      'mermaid.md',
    );
    const sharedUrl = buildSharedDocumentUrl(page.url(), archive, null);

    await page.evaluate((url) => {
      window.history.pushState(null, '', url);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, sharedUrl);

    const diagram = page.locator('[aria-label="flowchart-v2 diagram editor"]');
    await expect(diagram).toBeVisible({ timeout: 15_000 });
    await expect(
      diagram.getByRole('button', { name: 'DocBlocks, rect Mermaid node' }),
    ).toBeVisible();
    await expect(diagram.getByRole('button', { name: 'Squisq, rect Mermaid node' })).toBeVisible();
    await expect(page.locator('.squisq-mermaid-render-error')).toHaveCount(0);
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
    const showFilesButton = page.getByRole('button', { name: 'Show file list' });
    await expect(showFilesButton).toBeVisible();
    await expect(showFilesButton.locator('.db-mobile-files-icon svg')).toBeVisible();
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

  test('shell popovers close on Escape and return focus to their triggers', async ({ page }) => {
    const appMenu = page.locator('.db-app-menu-btn');
    await appMenu.click();
    await expect(page.locator('.db-app-menu-dropdown')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.db-app-menu-dropdown')).not.toBeVisible();
    await expect(appMenu).toBeFocused();

    const workspacePicker = page.locator('.db-workspace-picker-btn');
    await workspacePicker.click();
    await expect(page.locator('.db-workspace-dropdown')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.db-workspace-dropdown')).not.toBeVisible();
    await expect(workspacePicker).toBeFocused();

    const exportMenu = page.getByRole('button', { name: 'Export and share' });
    await exportMenu.click();
    await expect(page.locator('.db-toolbar-menu-dropdown')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.db-toolbar-menu-dropdown')).not.toBeVisible();
    await expect(exportMenu).toBeFocused();
  });

  test('applies and persists Write canvas typography settings', async ({ page }) => {
    await page.locator('.db-app-menu-btn').click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();

    const dialog = page.getByRole('dialog', { name: 'Settings' });
    const dialogLayout = await dialog.evaluate((element) => {
      const dialogRect = element.getBoundingClientRect();
      const accentRects = Array.from(
        element.querySelectorAll<HTMLElement>('.db-settings-accent'),
        (accent) => accent.getBoundingClientRect(),
      );
      return {
        width: Math.round(dialogRect.width),
        top: Math.round(dialogRect.top),
        bottom: Math.round(dialogRect.bottom),
        viewportHeight: window.innerHeight,
        accentRows: new Set(accentRects.map((rect) => Math.round(rect.top))).size,
        accentsInsideDialog: accentRects.every(
          (rect) => rect.left >= dialogRect.left && rect.right <= dialogRect.right,
        ),
      };
    });
    expect(dialogLayout.width).toBeGreaterThanOrEqual(550);
    expect(dialogLayout.top).toBeGreaterThanOrEqual(16);
    expect(dialogLayout.bottom).toBeLessThanOrEqual(dialogLayout.viewportHeight - 16);
    expect(dialogLayout.accentRows).toBe(2);
    expect(dialogLayout.accentsInsideDialog).toBe(true);

    const textSize = dialog.getByRole('slider', { name: 'Text size' });
    const lineSpacing = dialog.getByRole('slider', { name: 'Line spacing' });
    await expect(textSize).toHaveValue('16');
    await expect(lineSpacing).toHaveValue('1.7');

    await textSize.fill('20');
    await lineSpacing.fill('2');
    await expect(dialog.getByText('20px', { exact: true })).toBeVisible();
    await expect(dialog.getByText('2\u00d7', { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        page.locator('.squisq-editor-shell').evaluate((element) => ({
          textSize: getComputedStyle(element).getPropertyValue('--squisq-write-text-size').trim(),
          lineSpacing: getComputedStyle(element)
            .getPropertyValue('--squisq-write-line-spacing')
            .trim(),
        })),
      )
      .toEqual({ textSize: '20px', lineSpacing: '2' });
    expect(await page.evaluate(() => localStorage.getItem('docblocks:writeCanvasSettings'))).toBe(
      JSON.stringify({ textSize: 20, lineSpacing: 2, fontScheme: 'theme' }),
    );

    await page.reload();
    await expect(page.locator('.squisq-editor-shell')).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() =>
        page.locator('.squisq-editor-shell').evaluate((element) => ({
          textSize: getComputedStyle(element).getPropertyValue('--squisq-write-text-size').trim(),
          lineSpacing: getComputedStyle(element)
            .getPropertyValue('--squisq-write-line-spacing')
            .trim(),
        })),
      )
      .toEqual({ textSize: '20px', lineSpacing: '2' });
  });

  test('keeps Settings reachable and reflows accents in a compact viewport', async ({ page }) => {
    await page.setViewportSize({ width: 460, height: 460 });
    await page.locator('.db-app-menu-btn').click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();

    const layout = await page.getByRole('dialog', { name: 'Settings' }).evaluate((element) => {
      const dialogRect = element.getBoundingClientRect();
      const body = element.querySelector<HTMLElement>('.db-dialog-body');
      const accentRects = Array.from(
        element.querySelectorAll<HTMLElement>('.db-settings-accent'),
        (accent) => accent.getBoundingClientRect(),
      );
      if (!body) throw new Error('Settings dialog body was not found');
      return {
        left: Math.round(dialogRect.left),
        right: Math.round(dialogRect.right),
        top: Math.round(dialogRect.top),
        bottom: Math.round(dialogRect.bottom),
        accentRows: new Set(accentRects.map((rect) => Math.round(rect.top))).size,
        bodyScrolls: body.scrollHeight > body.clientHeight,
      };
    });

    expect(layout.left).toBeGreaterThanOrEqual(16);
    expect(layout.right).toBeLessThanOrEqual(444);
    expect(layout.top).toBeGreaterThanOrEqual(16);
    expect(layout.bottom).toBeLessThanOrEqual(444);
    expect(layout.accentRows).toBe(3);
    expect(layout.bodyScrolls).toBe(true);
  });

  test('moves a shared temporary document into a workspace and closes the temporary workspace', async ({
    page,
  }) => {
    const archive = await createSharedDocumentArchive(
      '# Moved shared document\n\nContent that should survive the move.\n',
      'shared.md',
    );
    const sharedUrl = buildSharedDocumentUrl(page.url(), archive, null);
    await page.evaluate((url) => {
      window.history.pushState(null, '', url);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, sharedUrl);

    await expect(page.locator('.db-workspace-picker-label')).toHaveText('Shared document');
    await expect(page.getByRole('button', { name: 'Move this into a workspace' })).toBeVisible();
    await page.getByRole('button', { name: 'Move this into a workspace' }).click();

    const moveForm = page.getByRole('form', { name: 'Move this into a workspace' });
    await expect(moveForm).toBeVisible();
    await moveForm.getByLabel('Move this document into').selectOption({ label: 'My Documents' });
    await moveForm.getByRole('button', { name: 'Move', exact: true }).click();

    await expect(page.locator('.db-workspace-picker-label')).toHaveText('My Documents');
    await expect(page).toHaveURL(/#default\/shared\.md$/);
    await expect(page.getByRole('heading', { name: 'Moved shared document' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Move this into a workspace' })).toHaveCount(0);

    await page.locator('.db-workspace-picker-btn').click();
    await expect(page.locator('.db-workspace-heading', { hasText: 'Shared document' })).toHaveCount(
      0,
    );
  });

  test('exports the active document as an exact Markdown download', async ({ page }) => {
    await page.getByRole('button', { name: 'Export and share' }).click();
    await page.getByRole('menuitem', { name: 'Export...' }).click();

    const dialog = page.getByRole('dialog', { name: 'Export Document' });
    await dialog.getByRole('radio', { name: 'Markdown' }).click();
    const downloadPromise = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toBe('aboutDocBlocks.md');
    const downloadPath = await download.path();
    if (!downloadPath) throw new Error('Browser export did not produce a downloadable file');
    const bytes = await import('node:fs/promises').then((fs) => fs.readFile(downloadPath));
    expect(bytes.toString('utf8')).toBe(WELCOME_DOCUMENT_CONTENT);
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
    await expect(buttons).toHaveCount(4); // Two sort controls plus +F and +D.
    const newFileButton = toolbar.getByRole('button', { name: 'New File' });
    const newFolderButton = toolbar.getByRole('button', { name: 'New Folder' });
    const newFileIcon = newFileButton.locator('.fa-file-circle-plus');
    await expect(newFileIcon).toBeVisible();
    await expect(newFileIcon).toHaveCSS('font-family', /Font Awesome/);
    await expect(newFolderButton.locator('.fa-folder-plus')).toBeVisible();

    await expect(page.locator('.db-ws-settings-btn .fa-gear')).toBeVisible();
  });

  test('shows support links in the footer', async ({ page }) => {
    const footer = page.locator('.db-shell-sidebar-footer');
    await expect(footer).toBeVisible();

    const docsLink = footer.getByRole('link', { name: 'Docs' });
    await expect(docsLink).toHaveAttribute('href', 'https://docblocks.com/docs/');

    const backup = footer.getByRole('button', { name: 'Back up browser docs' });
    await expect(backup).toBeVisible();
    expect(
      await backup.evaluate((element) => element.scrollWidth <= element.clientWidth),
      'the browser-document safety action should not be visually truncated',
    ).toBe(true);

    const termsLink = footer.getByRole('link', { name: 'Terms' });
    await expect(termsLink).toHaveAttribute('href', 'https://docblocks.com/terms/');

    const reportIssueLink = footer.getByRole('link', { name: 'Report issue' });
    const reportIssueHref = await reportIssueLink.getAttribute('href');
    if (!reportIssueHref) throw new Error('Report issue link did not have an href');
    const reportIssueUrl = new URL(reportIssueHref);
    const issueBody = reportIssueUrl.searchParams.get('body');
    expect(reportIssueUrl.origin).toBe('https://github.com');
    expect(reportIssueUrl.pathname).toBe('/bendyline/docblocks/issues/new');
    expect(issueBody).toMatch(/^- Date: \d{4}-\d{2}-\d{2}$/m);
    expect(issueBody).toMatch(/^- DocBlocks: \d+\.\d+\.\d+ web$/m);
    expect(issueBody).toContain('- User agent: Mozilla/5.0');

    const statusItem = page.locator('.squisq-status-item').first();
    await expect(statusItem).toBeVisible();
    const [linkBox, statusBox] = await Promise.all([
      termsLink.boundingBox(),
      statusItem.boundingBox(),
    ]);
    if (!linkBox || !statusBox) throw new Error('Footer alignment elements not found');

    const linkCenter = linkBox.y + linkBox.height / 2;
    const statusCenter = statusBox.y + statusBox.height / 2;
    // Font metrics can round the two line boxes to adjacent device pixels.
    expect(Math.abs(linkCenter - statusCenter)).toBeLessThanOrEqual(1);
  });
});

test.describe('File operations', () => {
  test.beforeEach(async ({ page }) => {
    await openInitializedSite(page);
  });

  test('can create a new file', async ({ page }) => {
    const newFileBtn = page.getByRole('button', { name: 'New File' });
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
    const newFileBtn = page.getByRole('button', { name: 'New File' });
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
    await page.getByRole('button', { name: 'New Folder' }).click();

    const input = page.locator('.db-new-item-input');
    await expect(input).toBeVisible();
    await input.fill('my-folder');
    await page.locator('.db-new-item-add').click();

    const treeRow = page.locator('.db-tree-row', { hasText: 'my-folder' });
    await expect(treeRow).toBeVisible({ timeout: 5_000 });
  });

  test('can drag a file into a folder and back to the workspace root', async ({ page }) => {
    await page.getByRole('button', { name: 'New File' }).click();
    await page.locator('.db-new-item-input').fill('drag-me');
    await page.locator('.db-new-item-add').click();

    await page.getByRole('button', { name: 'New Folder' }).click();
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

    await page.getByRole('button', { name: 'New Folder' }).click();
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
    const insertItem = menu.getByRole('button', { name: 'Insert...' });
    await expect(insertItem).toBeVisible();
    await expect(insertItem).toHaveClass(/squisq-toolbar-overflow-item/);

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
      const result = {
        menuBackground: menuStyle.backgroundColor,
        menuBorder: menuStyle.borderTopColor,
        itemColor: firstItem ? getComputedStyle(firstItem).color : '',
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
  });

  test('uses the active DocBlocks palette for the portaled Convert/Insert menu', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem('docblocks:themePreference', 'dark');
      localStorage.setItem('docblocks:accentColor', 'brown');
    });
    await openInitializedSite(page);
    await expect(page.locator('.db-shell[data-theme="dark"][data-accent="brown"]')).toBeVisible({
      timeout: 10_000,
    });

    await page.locator('.db-welcome-gateway-cta').click();
    await expect(page.locator('[contenteditable="true"]').first()).toBeVisible({
      timeout: 10_000,
    });

    await page.locator('.squisq-toolbar-overflow-trigger').click();
    const overflowMenu = page.locator('.squisq-toolbar-overflow-menu');
    await expect(overflowMenu).toBeVisible();
    await overflowMenu.getByRole('button', { name: 'Insert...' }).click();

    const insertMenu = page.locator('.squisq-insert-menu').first();
    await expect(insertMenu).toBeVisible();

    const colors = await insertMenu.evaluate((element) => {
      const probe = document.createElement('div');
      probe.style.cssText = [
        'position:absolute',
        'visibility:hidden',
        'background:var(--db-bg)',
        'border:1px solid var(--db-border)',
        'color:var(--db-text-secondary)',
      ].join(';');
      const mutedProbe = document.createElement('span');
      mutedProbe.style.color = 'var(--db-text-muted)';
      const hoverProbe = document.createElement('span');
      hoverProbe.style.background = 'var(--db-bg-hover)';
      probe.append(mutedProbe, hoverProbe);
      document.body.appendChild(probe);

      const menuStyle = getComputedStyle(element);
      const firstItem = element.querySelector<HTMLElement>('.squisq-toolbar-overflow-item');
      const header = element.querySelector<HTMLElement>('.squisq-insert-menu-header');
      const probeStyle = getComputedStyle(probe);
      const result = {
        menuBackground: menuStyle.backgroundColor,
        menuBorder: menuStyle.borderTopColor,
        itemColor: firstItem ? getComputedStyle(firstItem).color : '',
        headerColor: header ? getComputedStyle(header).color : '',
        expectedBackground: probeStyle.backgroundColor,
        expectedBorder: probeStyle.borderTopColor,
        expectedText: probeStyle.color,
        expectedMuted: getComputedStyle(mutedProbe).color,
        expectedHover: getComputedStyle(hoverProbe).backgroundColor,
      };
      probe.remove();
      return result;
    });

    expect(colors.menuBackground).toBe(colors.expectedBackground);
    expect(colors.menuBorder).toBe(colors.expectedBorder);
    expect(colors.itemColor).toBe(colors.expectedText);
    expect(colors.headerColor).toBe(colors.expectedMuted);

    const firstItem = insertMenu.locator('.squisq-toolbar-overflow-item').first();
    await firstItem.hover();
    await expect(firstItem).toHaveCSS('background-color', colors.expectedHover);
  });
});

test.describe('Squisq Use mode menu theming', () => {
  test('uses the active DocBlocks palette when portaled outside the shell', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('docblocks:themePreference', 'dark');
      localStorage.setItem('docblocks:accentColor', 'purple');
    });
    await openInitializedSite(page);
    await expect(page.locator('.db-shell[data-theme="dark"][data-accent="purple"]')).toBeVisible({
      timeout: 10_000,
    });

    await page.locator('.db-welcome-gateway-cta').click();
    await expect(page.locator('[contenteditable="true"]').first()).toBeVisible({
      timeout: 10_000,
    });

    await page.getByRole('button', { name: 'Choose Use mode' }).click();
    const menu = page.getByRole('menu', { name: 'Use mode' });
    await expect(menu).toBeVisible();

    const colors = await menu.evaluate((element) => {
      const probe = document.createElement('div');
      probe.style.cssText = [
        'position:absolute',
        'visibility:hidden',
        'background:var(--db-bg)',
        'border:1px solid var(--db-border)',
        'color:var(--db-text-secondary)',
      ].join(';');
      const hoverProbe = document.createElement('span');
      hoverProbe.style.background = 'var(--db-bg-hover)';
      const selectedProbe = document.createElement('span');
      selectedProbe.style.cssText = [
        'background:var(--db-accent-tint-strong)',
        'color:var(--db-accent-deep)',
      ].join(';');
      const accentProbe = document.createElement('span');
      accentProbe.style.color = 'var(--db-accent-hover)';
      const selectedIconProbe = document.createElement('span');
      selectedIconProbe.style.background = 'var(--db-accent-soft-25)';
      const mutedProbe = document.createElement('span');
      mutedProbe.style.color = 'var(--db-text-muted)';
      probe.append(hoverProbe, selectedProbe, accentProbe, selectedIconProbe, mutedProbe);
      document.body.appendChild(probe);

      const menuStyle = getComputedStyle(element);
      const normalItem = element.querySelector<HTMLElement>(
        '.squisq-use-mode-menu-item:not(.squisq-use-mode-menu-item--selected)',
      );
      const selectedItem = element.querySelector<HTMLElement>(
        '.squisq-use-mode-menu-item--selected',
      );
      const selectedIcon = selectedItem?.querySelector<HTMLElement>('.squisq-use-mode-menu-icon');
      const summary = normalItem?.querySelector<HTMLElement>('.squisq-use-mode-menu-summary');
      const check = selectedItem?.querySelector<HTMLElement>('.squisq-use-mode-menu-check');
      const probeStyle = getComputedStyle(probe);
      const result = {
        menuBackground: menuStyle.backgroundColor,
        menuBorder: menuStyle.borderTopColor,
        normalText: normalItem ? getComputedStyle(normalItem).color : '',
        selectedBackground: selectedItem ? getComputedStyle(selectedItem).backgroundColor : '',
        selectedText: selectedItem ? getComputedStyle(selectedItem).color : '',
        selectedIconBackground: selectedIcon ? getComputedStyle(selectedIcon).backgroundColor : '',
        selectedIconText: selectedIcon ? getComputedStyle(selectedIcon).color : '',
        summaryText: summary ? getComputedStyle(summary).color : '',
        checkText: check ? getComputedStyle(check).color : '',
        expectedBackground: probeStyle.backgroundColor,
        expectedBorder: probeStyle.borderTopColor,
        expectedNormalText: probeStyle.color,
        expectedHover: getComputedStyle(hoverProbe).backgroundColor,
        expectedSelectedBackground: getComputedStyle(selectedProbe).backgroundColor,
        expectedSelectedText: getComputedStyle(selectedProbe).color,
        expectedAccent: getComputedStyle(accentProbe).color,
        expectedSelectedIconBackground: getComputedStyle(selectedIconProbe).backgroundColor,
        expectedMuted: getComputedStyle(mutedProbe).color,
      };
      probe.remove();
      return result;
    });

    expect(colors.menuBackground).toBe(colors.expectedBackground);
    expect(colors.menuBorder).toBe(colors.expectedBorder);
    expect(colors.normalText).toBe(colors.expectedNormalText);
    expect(colors.selectedBackground).toBe(colors.expectedSelectedBackground);
    expect(colors.selectedText).toBe(colors.expectedSelectedText);
    expect(colors.selectedIconBackground).toBe(colors.expectedSelectedIconBackground);
    expect(colors.selectedIconText).toBe(colors.expectedAccent);
    expect(colors.summaryText).toBe(colors.expectedMuted);
    expect(colors.checkText).toBe(colors.expectedAccent);

    const normalItem = menu.locator('.squisq-use-mode-menu-item').filter({ hasText: 'Video' });
    await normalItem.hover();
    await expect(normalItem).toHaveCSS('background-color', colors.expectedHover);
  });
});

test.describe('Simple diagram theming', () => {
  test.use({ viewport: { width: 1280, height: 1000 } });

  test('uses the active DocBlocks accent and scene surfaces', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('docblocks:themePreference', 'dark');
      localStorage.setItem('docblocks:accentColor', 'brown');
    });
    await openInitializedSite(page);

    // The seeded welcome document already contains an editable Scene. Enter
    // Write once, then use it without racing Monaco's lazy Source-view mount.
    await page.locator('.db-welcome-gateway-cta').click();
    await expect(page.locator('[contenteditable="true"]').first()).toBeVisible({
      timeout: 10_000,
    });
    const scene = page.locator('.squisq-scene-shell').first();
    const card = scene.locator('[data-layer-id^="node-card-"]').first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    const cardBox = await card.boundingBox();
    if (!cardBox) throw new Error('Diagram card bounds were not found');
    await page.mouse.click(cardBox.x + 8, cardBox.y + 8);
    await expect(scene.locator('.squisq-scene-selection-outline')).toBeVisible();
    const handle = scene.locator('.squisq-scene-selection-handle').first();
    await expect(handle).toBeVisible();
    const handleStroke = await handle.evaluate((element) => getComputedStyle(element).stroke);
    await scene.getByRole('button', { name: 'Connect' }).click();
    const fitButton = scene.getByRole('button', { name: 'Fit diagram' });
    await fitButton.click();
    await expect(fitButton).toHaveAttribute('aria-pressed', 'true');

    const colors = await scene.evaluate((element) => {
      const shell = document.querySelector<HTMLElement>('.db-shell');
      const root = element.querySelector<HTMLElement>('.squisq-scene-root');
      const toolbar = element.querySelector<HTMLElement>('.squisq-scene-block-tools');
      const connect = Array.from(element.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent?.trim() === 'Connect',
      );
      const fit = element.querySelector<HTMLButtonElement>(
        '.squisq-scene-view-fit[data-active="true"]',
      );
      const selection = element.querySelector<SVGElement>('.squisq-scene-selection-outline');
      if (!shell || !root || !toolbar || !connect || !fit || !selection) {
        const missing = [
          !shell && 'shell',
          !root && 'root',
          !toolbar && 'toolbar',
          !connect && 'connect',
          !fit && 'fit',
          !selection && 'selection',
        ].filter(Boolean);
        throw new Error(`Diagram theme probes were not found: ${missing.join(', ')}`);
      }

      const accentProbe = document.createElement('div');
      accentProbe.style.cssText = [
        'position:absolute',
        'visibility:hidden',
        'background:var(--db-accent)',
        'border:1px solid var(--db-accent-hover)',
        'color:var(--db-text-on-accent)',
      ].join(';');
      const surfaceProbe = document.createElement('div');
      surfaceProbe.style.cssText = [
        'position:absolute',
        'visibility:hidden',
        'background:var(--db-editor-canvas)',
        'border:1px solid var(--db-border-strong)',
      ].join(';');
      const raisedProbe = document.createElement('div');
      raisedProbe.style.cssText =
        'position:absolute;visibility:hidden;background:var(--db-bg-subtle)';
      shell.append(accentProbe, surfaceProbe, raisedProbe);

      const accentStyle = getComputedStyle(accentProbe);
      const surfaceStyle = getComputedStyle(surfaceProbe);
      const result = {
        connectBackground: getComputedStyle(connect).backgroundColor,
        connectBorder: getComputedStyle(connect).borderTopColor,
        connectColor: getComputedStyle(connect).color,
        fitBackground: getComputedStyle(fit).backgroundColor,
        selectionStroke: getComputedStyle(selection).stroke,
        canvasBackground: getComputedStyle(root).backgroundColor,
        canvasBorder: getComputedStyle(root).borderTopColor,
        toolbarBackground: getComputedStyle(toolbar).backgroundColor,
        expectedAccent: accentStyle.backgroundColor,
        expectedAccentHover: accentStyle.borderTopColor,
        expectedAccentText: accentStyle.color,
        expectedCanvas: surfaceStyle.backgroundColor,
        expectedBorder: surfaceStyle.borderTopColor,
        expectedRaised: getComputedStyle(raisedProbe).backgroundColor,
      };
      accentProbe.remove();
      surfaceProbe.remove();
      raisedProbe.remove();
      return result;
    });

    expect(colors.connectBackground).toBe(colors.expectedAccent);
    expect(colors.connectBorder).toBe(colors.expectedAccentHover);
    expect(colors.connectColor).toBe(colors.expectedAccentText);
    expect(colors.fitBackground).toBe(colors.expectedAccent);
    expect(colors.selectionStroke).toBe(colors.expectedAccent);
    expect(handleStroke).toBe(colors.expectedAccent);
    expect(colors.canvasBackground).toBe(colors.expectedCanvas);
    expect(colors.canvasBorder).toBe(colors.expectedBorder);
    expect(colors.toolbarBackground).toBe(colors.expectedRaised);
  });
});

test.describe('Video export dialog theming', () => {
  test('offers Animated GIF as a built-in ffmpeg-backed export', async ({ page }) => {
    await openInitializedSite(page);
    expect(
      await page.evaluate(() => ({
        crossOriginIsolated: globalThis.crossOriginIsolated,
        sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
      })),
    ).toEqual({ crossOriginIsolated: true, sharedArrayBuffer: true });

    await page.getByRole('button', { name: 'Export and share' }).click();
    await page.getByRole('menuitem', { name: 'Export animated gif...' }).click();

    const dialog = page.getByRole('dialog', { name: 'Export Animated GIF' });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    // The lightweight loading dialog is replaced by the lazy video-export
    // modal. Keep the assertion across that Suspense transition.
    await expect(dialog.getByLabel('Format')).toHaveValue('gif', { timeout: 30_000 });
  });

  test('uses the active DocBlocks accent palette', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('docblocks:themePreference', 'dark');
      localStorage.setItem('docblocks:accentColor', 'green');
    });
    await openInitializedSite(page);
    await expect(page.locator('.db-shell[data-theme="dark"][data-accent="green"]')).toBeVisible({
      timeout: 10_000,
    });
    await page.locator('.db-welcome-gateway-cta').click();
    await expect(page.locator('[contenteditable="true"]').first()).toBeVisible({
      timeout: 10_000,
    });

    await page.getByRole('button', { name: 'Export and share' }).click();
    await page.getByRole('menuitem', { name: 'Export video...' }).click();

    const overlay = page.locator('[data-color-scheme="dark"]', { hasText: 'Export Video' });
    await expect(overlay).toBeVisible({ timeout: 30_000 });
    const colors = await overlay.evaluate((element) => {
      const shell = document.querySelector<HTMLElement>('.db-shell');
      const panel = element.querySelector<HTMLElement>('[data-squisq-video-export-modal]');
      const select = element.querySelector('select');
      const primary = Array.from(element.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Export Video',
      );
      if (!shell || !panel || !(select instanceof HTMLSelectElement) || !primary) {
        throw new Error('Video export theme probes were not found');
      }

      const probe = document.createElement('div');
      probe.style.cssText = [
        'position:fixed',
        'visibility:hidden',
        'background:var(--db-bg)',
        'color:var(--db-text)',
        'border:1px solid var(--db-border-strong)',
      ].join(';');
      const controlProbe = document.createElement('div');
      controlProbe.style.cssText = 'background:var(--db-bg-subtle)';
      const accentProbe = document.createElement('div');
      accentProbe.style.cssText = [
        'background:var(--db-accent)',
        'color:var(--db-text-on-accent)',
      ].join(';');
      shell.append(probe, controlProbe, accentProbe);

      const panelStyle = getComputedStyle(panel);
      const selectStyle = getComputedStyle(select);
      const primaryStyle = getComputedStyle(primary);
      const probeStyle = getComputedStyle(probe);
      const controlProbeStyle = getComputedStyle(controlProbe);
      const accentProbeStyle = getComputedStyle(accentProbe);
      const result = {
        panelBackground: panelStyle.backgroundColor,
        panelBorder: panelStyle.borderTopColor,
        panelColor: panelStyle.color,
        panelColorScheme: panelStyle.colorScheme,
        selectBackground: selectStyle.backgroundColor,
        primaryBackground: primaryStyle.backgroundColor,
        primaryColor: primaryStyle.color,
        expectedBackground: probeStyle.backgroundColor,
        expectedBorder: probeStyle.borderTopColor,
        expectedText: probeStyle.color,
        expectedControl: controlProbeStyle.backgroundColor,
        expectedAccent: accentProbeStyle.backgroundColor,
        expectedAccentText: accentProbeStyle.color,
      };
      probe.remove();
      controlProbe.remove();
      accentProbe.remove();
      return result;
    });

    expect(colors.panelColorScheme).toContain('dark');
    expect(colors.panelBackground).toBe(colors.expectedBackground);
    expect(colors.panelBorder).toBe(colors.expectedBorder);
    expect(colors.panelColor).toBe(colors.expectedText);
    expect(colors.selectBackground).toBe(colors.expectedControl);
    expect(colors.primaryBackground).toBe(colors.expectedAccent);
    expect(colors.primaryColor).toBe(colors.expectedAccentText);
  });
});

test.describe('Squisq block type picker theming', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('uses the active DocBlocks accent in the portaled picker', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('docblocks:themePreference', 'dark');
      localStorage.setItem('docblocks:accentColor', 'green');
    });
    await openInitializedSite(page);
    await expect(page.locator('.db-shell[data-theme="dark"][data-accent="green"]')).toBeVisible({
      timeout: 10_000,
    });

    await page.locator('.db-welcome-gateway-cta').click();
    await expect(page.locator('[contenteditable="true"]').first()).toBeVisible({
      timeout: 10_000,
    });

    const heading = page.locator('.tiptap.ProseMirror').locator('h1, h2, h3').first();
    await heading.click({ position: { x: 8, y: 8 } });
    const trigger = heading.locator('.squisq-template-badge').first();
    await expect(trigger).toBeVisible();
    await trigger.click();

    const dialog = page.locator(
      '.squisq-template-gallery-dialog:has([data-squisq-template-gallery-portal])',
    );
    await expect(dialog).toBeVisible();

    const colors = await dialog.evaluate((element) => {
      const shell = document.querySelector<HTMLElement>('.db-shell');
      const selected = element.querySelector<HTMLElement>(
        '.squisq-template-gallery-card--selected',
      );
      const newBlockType = element.querySelector<HTMLElement>('.squisq-template-gallery-new-plus');
      if (!shell || !selected || !newBlockType) {
        throw new Error('Block type picker accent probes were not found');
      }

      const probe = document.createElement('div');
      probe.style.cssText =
        'position:absolute;visibility:hidden;border:1px solid var(--db-accent-hover)';
      shell.appendChild(probe);

      const result = {
        expectedAccent: getComputedStyle(probe).borderTopColor,
        selectedBorder: getComputedStyle(selected).borderTopColor,
        newBlockTypeColor: getComputedStyle(newBlockType).color,
      };
      probe.remove();
      return result;
    });

    expect(colors.selectedBorder).toBe(colors.expectedAccent);
    expect(colors.newBlockTypeColor).toBe(colors.expectedAccent);
  });
});

test.describe('Squisq custom layout theming', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('uses the active DocBlocks accent in the portaled layout manager', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('docblocks:themePreference', 'dark');
      localStorage.setItem('docblocks:accentColor', 'green');
    });
    await openInitializedSite(page);
    await expect(page.locator('.db-shell[data-theme="dark"][data-accent="green"]')).toBeVisible({
      timeout: 10_000,
    });

    await page.locator('.db-welcome-gateway-cta').click();
    await expect(page.locator('[contenteditable="true"]').first()).toBeVisible({
      timeout: 10_000,
    });
    await page.getByRole('button', { name: 'Custom layouts' }).click();

    const dialog = page.getByRole('dialog', { name: 'Custom layouts' });
    await expect(dialog).toBeVisible();

    const colors = await dialog.evaluate((element) => {
      const shell = document.querySelector<HTMLElement>('.db-shell');
      const newLayout = element.querySelector<HTMLElement>('.squisq-layout-manager-new--active');
      const primary = element.querySelector<HTMLElement>('.squisq-template-designer-btn--primary');
      const paletteTitle = element.querySelector<HTMLElement>(
        '.squisq-template-designer-palette-title',
      );
      if (!shell || !newLayout || !primary || !paletteTitle) {
        throw new Error('Custom layout accent probes were not found');
      }

      const probe = document.createElement('div');
      probe.style.cssText = [
        'position:absolute',
        'visibility:hidden',
        'background:var(--db-accent)',
        'border:1px solid var(--db-accent-tint-strong)',
        'color:var(--db-text-on-accent)',
        'outline:1px solid var(--db-accent-hover)',
      ].join(';');
      shell.appendChild(probe);

      const result = {
        expectedAccent: getComputedStyle(probe).backgroundColor,
        expectedAccentSoft: getComputedStyle(probe).borderTopColor,
        expectedAccentText: getComputedStyle(probe).color,
        expectedAccentHover: getComputedStyle(probe).outlineColor,
        newLayoutBackground: getComputedStyle(newLayout).backgroundColor,
        primaryBackground: getComputedStyle(primary).backgroundColor,
        primaryColor: getComputedStyle(primary).color,
        paletteTitleColor: getComputedStyle(paletteTitle).color,
      };
      probe.remove();
      return result;
    });

    expect(colors.newLayoutBackground).toBe(colors.expectedAccentSoft);
    expect(colors.primaryBackground).toBe(colors.expectedAccent);
    expect(colors.primaryColor).toBe(colors.expectedAccentText);
    expect(colors.paletteTitleColor).toBe(colors.expectedAccentHover);
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
