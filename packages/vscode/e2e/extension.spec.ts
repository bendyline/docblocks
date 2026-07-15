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
 * Open the DocBlocks setup tab via command palette.
 */
async function openDocBlocksSetupTab(page: Page) {
  await page.keyboard.press('F1');
  await page.waitForTimeout(500);
  await page.keyboard.type('DocBlocks: Open DocBlocks Tools (CLI+MCP) Setup');
  await page.waitForTimeout(1_000);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3_000);
}

/**
 * Right-click a file in the explorer and select "Open in DocBlocks".
 */
async function openFileInDocBlocks(page: Page, fileName: string) {
  const explorer = page.locator('.explorer-folders-view');
  const file = explorer.getByText(fileName);
  await expect(file).toBeVisible({ timeout: 10_000 });

  await file.click({ button: 'right' });
  await page.waitForTimeout(1_000);

  const openInDocBlocks = page
    .locator('.context-view .action-label')
    .filter({ hasText: 'Open in DocBlocks' });
  await openInDocBlocks.click();
  await page.waitForTimeout(3_000);
}

async function openFileByDefault(page: Page, fileName: string) {
  const explorer = page.locator('.explorer-folders-view');
  const file = explorer.getByText(fileName);
  await expect(file).toBeVisible({ timeout: 10_000 });
  await file.click();
  await page.waitForTimeout(3_000);
}

const LONGEST_DUPLICATE_TABS_ATTRIBUTE = 'data-docblocks-longest-duplicate-tabs-ms';

async function monitorDuplicateTabDuration(page: Page, fileName: string): Promise<void> {
  await page.evaluate(
    ({ longestDurationAttribute, targetFileName }) => {
      const root = document.documentElement;
      root.setAttribute(longestDurationAttribute, '0');
      let duplicateStartedAt: number | null = null;

      const updateDuration = () => {
        const matchingTabs = [...document.querySelectorAll('.tabs-container .tab')].filter((tab) =>
          tab.textContent?.includes(targetFileName),
        ).length;
        if (matchingTabs > 1) {
          duplicateStartedAt ??= performance.now();
          return;
        }
        if (duplicateStartedAt === null) return;

        const previousLongest = Number(root.getAttribute(longestDurationAttribute) ?? '0');
        const duplicateDuration = performance.now() - duplicateStartedAt;
        root.setAttribute(
          longestDurationAttribute,
          String(Math.max(previousLongest, duplicateDuration)),
        );
        duplicateStartedAt = null;
      };

      const observer = new MutationObserver(updateDuration);
      observer.observe(document.body, { childList: true, characterData: true, subtree: true });
      window.setTimeout(() => observer.disconnect(), 15_000);
      updateDuration();
    },
    {
      longestDurationAttribute: LONGEST_DUPLICATE_TABS_ATTRIBUTE,
      targetFileName: fileName,
    },
  );
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

  test('DocBlocks setup command is registered', async ({ page }) => {
    await page.keyboard.press('F1');
    const quickInput = page.locator('.quick-input-widget');
    await expect(quickInput).toBeVisible({ timeout: 5_000 });

    await page.keyboard.type('DocBlocks: Open DocBlocks Tools (CLI+MCP) Setup');
    await page.waitForTimeout(1_000);

    await expect(
      quickInput.getByText('DocBlocks: Open DocBlocks Tools (CLI+MCP) Setup'),
    ).toBeVisible({
      timeout: 5_000,
    });
  });
});

// ── Setup tab ─────────────────────────────────────────────────────

test.describe('Setup tab', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForVSCode(page);
  });

  test('setup tab opens from the command palette', async ({ page }) => {
    await openDocBlocksSetupTab(page);

    const setupTab = page.locator('.tabs-container .tab').filter({ hasText: 'DocBlocks Setup' });
    await expect(setupTab).toBeVisible({ timeout: 10_000 });

    const webviews = page.locator('iframe.webview');
    await expect(webviews.last()).toBeVisible({ timeout: 15_000 });
  });

  test('setup tab shows environment check items', async ({ page }) => {
    await openDocBlocksSetupTab(page);

    const content = await getWebviewContent(page);

    await expect(content.locator('h2')).toContainText('DocBlocks Setup', {
      timeout: 10_000,
    });

    await expect(content.locator('#check-node')).toBeVisible();
    await expect(content.locator('#check-npm')).toBeVisible();
    await expect(content.locator('#check-cli')).toBeVisible();
    await expect(content.locator('#check-mcp')).toBeVisible();
  });

  test('setup tab has re-check button', async ({ page }) => {
    await openDocBlocksSetupTab(page);

    const content = await getWebviewContent(page);

    const refreshBtn = content.locator('.refresh-btn');
    await expect(refreshBtn).toBeVisible({ timeout: 10_000 });
    await expect(refreshBtn).toContainText('Re-check');
  });
});

// ── Markdown editor panel ─────────────────────────────────────────

test.describe('Markdown editor panel', () => {
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

  test('can open markdown file with DocBlocks context menu', async ({ page }) => {
    const explorer = page.locator('.explorer-folders-view');
    const testFile = explorer.getByText('test-doc.md');
    await expect(testFile).toBeVisible({ timeout: 10_000 });

    await testFile.click({ button: 'right' });
    await page.waitForTimeout(1_000);

    const openInDocBlocks = page
      .locator('.context-view .action-label')
      .filter({ hasText: 'Open in DocBlocks' });
    await expect(openInDocBlocks).toBeVisible({ timeout: 5_000 });
    await openInDocBlocks.click();

    const webviews = page.locator('iframe.webview');
    await expect(webviews.last()).toBeVisible({ timeout: 15_000 });
  });

  test('selecting markdown file opens DocBlocks by default', async ({ page }) => {
    await monitorDuplicateTabDuration(page, 'test-doc.md');
    await openFileByDefault(page, 'test-doc.md');

    const webviews = page.locator('iframe.webview');
    await expect(webviews.last()).toBeVisible({ timeout: 15_000 });
    await expect(
      page.locator('.tabs-container .tab').filter({ hasText: 'test-doc.md' }),
    ).toHaveCount(1);
    const duplicateTabDuration = Number(
      await page.locator('html').getAttribute(LONGEST_DUPLICATE_TABS_ATTRIBUTE),
    );
    expect(duplicateTabDuration).toBeLessThan(250);
    // VS Code's registered custom-editor route owns a native breadcrumb that
    // identifies the editor type. The explicit "Open in DocBlocks" panel
    // route below does not, so keep their expectations distinct.
    await expect(page.locator('.part.editor .breadcrumbs-control')).toContainText(
      'DocBlocks Editor',
      {
        timeout: 10_000,
      },
    );
  });

  test('DocBlocks editor opens and shows webview', async ({ page }) => {
    await openFileInDocBlocks(page, 'test-doc.md');

    // A new webview iframe should have appeared
    const webviews = page.locator('iframe.webview');
    await expect(webviews.last()).toBeVisible({ timeout: 15_000 });

    // Access the editor webview content
    const content = await getWebviewContent(page);

    // The React root should be rendered
    const root = content.locator('#root');
    await expect(root).toBeVisible({ timeout: 15_000 });
  });

  test('DocBlocks editor does not show VS Code breadcrumbs', async ({ page }) => {
    await openFileInDocBlocks(page, 'test-doc.md');

    await expect(page.locator('.part.editor .breadcrumbs-control')).toBeHidden({
      timeout: 10_000,
    });
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

  test('DocBlocks setup command is available', async ({ page }) => {
    await page.keyboard.press('F1');
    const quickInput = page.locator('.quick-input-widget');
    await expect(quickInput).toBeVisible({ timeout: 5_000 });

    await page.keyboard.type('DocBlocks: Open DocBlocks Tools (CLI+MCP) Setup');
    await page.waitForTimeout(1_000);

    const setupCmd = quickInput.getByText('DocBlocks: Open DocBlocks Tools (CLI+MCP) Setup');
    await expect(setupCmd).toBeVisible({ timeout: 5_000 });
  });
});
