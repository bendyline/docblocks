import { test, expect, type FrameLocator, type Page } from '@playwright/test';

const fixturePath = 'test-fixtures/test-doc.md';
const editSentinel = 'VS Code webview edit sync sentinel';

async function bootVSCode(page: Page): Promise<void> {
  await page.goto('/');
  await waitForVSCode(page);
}

async function waitForVSCode(page: Page): Promise<void> {
  await page.waitForSelector('.monaco-workbench', { timeout: 30_000 });
  await page.waitForSelector('.activitybar', { timeout: 15_000 });
}

async function getLatestWebviewContent(page: Page): Promise<FrameLocator> {
  const webviews = page.locator('iframe.webview');
  await expect(webviews.last()).toBeVisible({ timeout: 15_000 });

  const outerFrame = webviews.last().contentFrame();
  const activeFrame = outerFrame.locator('iframe#active-frame');
  await expect(activeFrame).toBeVisible({ timeout: 15_000 });
  return activeFrame.contentFrame();
}

async function runCommand(page: Page, command: string): Promise<void> {
  await page.keyboard.press('F1');
  const quickInput = page.locator('.quick-input-widget');
  await expect(quickInput).toBeVisible({ timeout: 10_000 });

  await page.keyboard.type(command);
  const option = quickInput.getByText(command).first();
  await expect(option).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Enter');
}

async function chooseFileEditor(
  page: Page,
  editorName: string,
  { assertDocBlocksMenu = false, fileName = 'test-doc.md' } = {},
): Promise<void> {
  const explorer = page.locator('.explorer-folders-view');
  const file = explorer.getByText(fileName);
  await expect(file).toBeVisible({ timeout: 10_000 });

  async function openFileContextMenu() {
    await file.click({ button: 'right' });
    await expect(page.locator('.context-view')).toBeVisible({ timeout: 5_000 });
  }

  await file.click();
  await page.waitForTimeout(300);
  await openFileContextMenu();

  if (assertDocBlocksMenu) {
    const openInDocBlocks = page
      .locator('.context-view .action-label')
      .filter({ hasText: 'Open in DocBlocks' });
    await expect(openInDocBlocks).toBeVisible({ timeout: 5_000 });
  }

  const openWith = page.locator('.context-view .action-label').filter({ hasText: 'Open With...' });
  await expect(openWith).toBeVisible({ timeout: 5_000 });
  await openWith.click();
  await page.waitForTimeout(500);

  const quickInput = page.locator('.quick-input-widget');
  const editorOption = quickInput.getByText(editorName).first();
  try {
    await expect(editorOption).toBeVisible({ timeout: 2_000 });
  } catch {
    await page.keyboard.press('Enter');
    await expect(editorOption).toBeVisible({ timeout: 5_000 });
  }
  await editorOption.click();
}

async function openDocBlocksEditor(page: Page, fileName = 'test-doc.md'): Promise<void> {
  await chooseFileEditor(page, 'DocBlocks Editor', { assertDocBlocksMenu: true, fileName });

  const webviews = page.locator('iframe.webview');
  await expect(webviews.last()).toBeVisible({ timeout: 15_000 });
  const content = await getLatestWebviewContent(page);
  await expect(content.locator('#root')).toBeVisible({ timeout: 15_000 });
}

async function readFixture(): Promise<string> {
  const fs = await import('node:fs/promises');
  return fs.readFile(fixturePath, 'utf8');
}

async function writeFixture(content: string): Promise<void> {
  const fs = await import('node:fs/promises');
  await fs.writeFile(fixturePath, content);
}

test.describe('VS Code web and UX integration', () => {
  let originalFixture = '';

  test.beforeAll(async () => {
    originalFixture = await readFixture();
  });

  test.afterAll(async () => {
    await writeFixture(originalFixture);
  });

  test.beforeEach(async () => {
    await writeFixture(originalFixture);
  });

  test('opens setup from the command palette and completes visible environment checks', async ({
    page,
  }) => {
    await bootVSCode(page);
    await runCommand(page, 'DocBlocks: Open Setup');

    const setup = await getLatestWebviewContent(page);
    await expect(setup.locator('h2')).toHaveText('DocBlocks Setup');
    await expect(setup.locator('#check-node')).toBeVisible();
    await expect(setup.locator('#check-npm')).toBeVisible();
    await expect(setup.locator('#check-cli')).toBeVisible();

    const refresh = setup.getByRole('button', { name: /re-check environment/i });
    await expect(refresh).toBeVisible();
    await refresh.click();

    await expect(setup.locator('#check-node .check-detail')).not.toHaveText('Checking...', {
      timeout: 20_000,
    });
    await expect(setup.locator('#check-npm .check-detail')).not.toHaveText('Checking...', {
      timeout: 20_000,
    });
  });

  test('loads the custom editor with expected mode tabs and rendered fixture content', async ({
    page,
  }) => {
    await bootVSCode(page);
    await openDocBlocksEditor(page);

    const editor = await getLatestWebviewContent(page);
    await expect(editor.getByRole('toolbar', { name: /formatting toolbar/i })).toBeVisible();
    await expect(editor.getByRole('tab', { name: /editor/i })).toBeVisible();
    await expect(editor.getByRole('tab', { name: /markdown/i })).toBeVisible();
    await expect(editor.getByRole('tab', { name: /play/i })).toBeVisible();
    await expect(editor.locator('body')).toContainText('Test Document');

    await editor.getByRole('tab', { name: /markdown/i }).click();
    await expect(editor.locator('.monaco-editor')).toBeVisible({ timeout: 15_000 });

    await editor.getByRole('tab', { name: /play/i }).click();
    await expect(editor.locator('body')).toContainText('Test Document', { timeout: 15_000 });
  });

  test('edits in the webview and syncs the changed markdown document', async ({ page }) => {
    await bootVSCode(page);
    await openDocBlocksEditor(page);

    const editor = await getLatestWebviewContent(page);
    const finalParagraph = editor.getByText('A blockquote for testing purposes.').first();
    await expect(finalParagraph).toBeVisible({ timeout: 15_000 });
    await finalParagraph.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText(editSentinel);

    await page.waitForTimeout(600);
    await expect(editor.locator('body')).toContainText(editSentinel);

    await chooseFileEditor(page, 'Text Editor');

    await expect(page.locator('.monaco-editor .view-lines')).toContainText(editSentinel, {
      timeout: 10_000,
    });
  });
});
