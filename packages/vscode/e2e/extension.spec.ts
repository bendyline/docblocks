import { test, expect, type Page, type FrameLocator } from '@playwright/test';

/**
 * Wait for VS Code for the Web to fully load.
 */
async function waitForVSCode(page: Page) {
  await page.waitForSelector('.monaco-workbench', { timeout: 30_000 });
  await page.waitForSelector('.activitybar', { timeout: 15_000 });
}

/**
 * Navigate into a VS Code webview's nested iframe structure.
 * VS Code webviews are page-level iframes with class "webview ready".
 * Each has an inner iframe#active-frame containing the actual content.
 */
async function getWebviewContent(page: Page): Promise<FrameLocator> {
  // VS Code may have multiple webviews — get the most recently added one
  const webviews = page.locator('iframe.webview');
  const count = await webviews.count();
  const outerFrame = webviews.nth(count - 1).contentFrame();
  const innerIframe = outerFrame.locator('iframe#active-frame');
  return innerIframe.contentFrame();
}

/**
 * Open the DocBlocks sidebar pane via command palette.
 */
async function openDocBlocksPane(page: Page) {
  await page.keyboard.press('F1');
  await page.waitForTimeout(500);
  await page.keyboard.type('View: Show DocBlocks');
  await page.waitForTimeout(1_000);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3_000);
}

/**
 * Right-click a file in the explorer and select "Open With..." > editor.
 */
async function openFileWithEditor(page: Page, fileName: string, editorName: string) {
  const explorer = page.locator('.explorer-folders-view');
  const file = explorer.getByText(fileName);
  await expect(file).toBeVisible({ timeout: 10_000 });

  // Select the file first, then right-click
  await file.click();
  await page.waitForTimeout(300);
  await file.click({ button: 'right' });
  await page.waitForTimeout(1_000);

  // Click "Open With..."
  const openWith = page.locator('.context-view .action-label').filter({ hasText: 'Open With...' });
  await openWith.click();
  await page.waitForTimeout(1_000);

  // Select the editor from the quick pick
  const quickInput = page.locator('.quick-input-widget');
  await quickInput.getByText(editorName).click();
  await page.waitForTimeout(3_000);
}

// ── Extension activation ──────────────────────────────────────────

test.describe('Extension activation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForVSCode(page);
  });

  test('VS Code for the Web loads successfully', async ({ page }) => {
    await expect(page.locator('.monaco-workbench')).toBeVisible();
  });

  test('activity bar has DocBlocks icon', async ({ page }) => {
    const docblocksItem = page.locator('.activitybar a[aria-label="DocBlocks"]');
    await expect(docblocksItem).toBeVisible({ timeout: 10_000 });
  });
});

// ── Setup pane ────────────────────────────────────────────────────

test.describe('Setup pane', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForVSCode(page);
  });

  test('setup pane opens when clicking DocBlocks activity bar icon', async ({ page }) => {
    await page.locator('.activitybar a[aria-label="DocBlocks"]').click();
    await page.waitForTimeout(2_000);

    const sidebar = page.locator('.part.sidebar');
    await expect(sidebar).toBeVisible({ timeout: 10_000 });
  });

  test('setup pane shows environment check items', async ({ page }) => {
    await openDocBlocksPane(page);

    const content = await getWebviewContent(page);

    await expect(content.locator('h2')).toContainText('DocBlocks Setup', {
      timeout: 10_000,
    });

    await expect(content.locator('#check-node')).toBeVisible();
    await expect(content.locator('#check-npm')).toBeVisible();
    await expect(content.locator('#check-cli')).toBeVisible();
  });

  test('setup pane has re-check button', async ({ page }) => {
    await openDocBlocksPane(page);

    const content = await getWebviewContent(page);

    const refreshBtn = content.locator('.refresh-btn');
    await expect(refreshBtn).toBeVisible({ timeout: 10_000 });
    await expect(refreshBtn).toContainText('Re-check');
  });
});

// ── Custom markdown editor ────────────────────────────────────────

test.describe('Custom markdown editor', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForVSCode(page);
  });

  test('test fixture file is visible in explorer', async ({ page }) => {
    const explorer = page.locator('.explorer-folders-view');
    await expect(explorer).toBeVisible({ timeout: 10_000 });

    const testFile = explorer.getByText('test-doc.md');
    await expect(testFile).toBeVisible({ timeout: 10_000 });
  });

  test('can open markdown file with Open With context menu', async ({ page }) => {
    const explorer = page.locator('.explorer-folders-view');
    const testFile = explorer.getByText('test-doc.md');
    await expect(testFile).toBeVisible({ timeout: 10_000 });

    // Select and right-click
    await testFile.click();
    await page.waitForTimeout(300);
    await testFile.click({ button: 'right' });
    await page.waitForTimeout(1_000);

    const openWith = page
      .locator('.context-view .action-label')
      .filter({ hasText: 'Open With...' });
    await expect(openWith).toBeVisible({ timeout: 5_000 });
    await openWith.click();
    await page.waitForTimeout(1_000);

    // DocBlocks Editor should be listed in the quick pick
    const quickInput = page.locator('.quick-input-widget');
    const docblocksOption = quickInput.getByText('DocBlocks Editor');
    await expect(docblocksOption).toBeVisible({ timeout: 5_000 });
  });

  test('DocBlocks editor opens and shows webview', async ({ page }) => {
    await openFileWithEditor(page, 'test-doc.md', 'DocBlocks Editor');

    // A new webview iframe should have appeared
    const webviews = page.locator('iframe.webview');
    await expect(webviews.last()).toBeVisible({ timeout: 15_000 });

    // Access the editor webview content
    const content = await getWebviewContent(page);

    // The React root should be rendered
    const root = content.locator('#root');
    await expect(root).toBeVisible({ timeout: 15_000 });
  });
});

// ── Commands ──────────────────────────────────────────────────────

test.describe('Commands', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForVSCode(page);
  });

  test('DocBlocks commands are registered in command palette', async ({ page }) => {
    await page.keyboard.press('F1');
    const quickInput = page.locator('.quick-input-widget');
    await expect(quickInput).toBeVisible({ timeout: 5_000 });

    await page.keyboard.type('DocBlocks');
    await page.waitForTimeout(1_000);

    const openEditorCmd = quickInput.getByText('DocBlocks: Open Editor');
    await expect(openEditorCmd).toBeVisible({ timeout: 5_000 });
  });

  test('View: Show DocBlocks command is available', async ({ page }) => {
    await page.keyboard.press('F1');
    const quickInput = page.locator('.quick-input-widget');
    await expect(quickInput).toBeVisible({ timeout: 5_000 });

    await page.keyboard.type('Show DocBlocks');
    await page.waitForTimeout(1_000);

    const showCmd = quickInput.getByText('View: Show DocBlocks');
    await expect(showCmd).toBeVisible({ timeout: 5_000 });
  });
});
