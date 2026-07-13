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

async function openFileContextMenu(page: Page, fileName = 'test-doc.md') {
  const explorer = page.locator('.explorer-folders-view');
  const file = explorer.getByText(fileName);
  await expect(file).toBeVisible({ timeout: 10_000 });

  await file.click({ button: 'right' });
  await expect(page.locator('.context-view')).toBeVisible({ timeout: 5_000 });
}

async function openTextEditorWithOpenWith(page: Page, fileName = 'test-doc.md'): Promise<void> {
  await openFileContextMenu(page, fileName);

  const openWith = page.locator('.context-view .action-label').filter({ hasText: 'Open With...' });
  await expect(openWith).toBeVisible({ timeout: 5_000 });
  await openWith.click();
  await page.waitForTimeout(500);

  const quickInput = page.locator('.quick-input-widget');
  const textEditorOption = quickInput.getByText('Text Editor').first();
  try {
    await expect(textEditorOption).toBeVisible({ timeout: 2_000 });
  } catch {
    await page.keyboard.press('Enter');
    await expect(textEditorOption).toBeVisible({ timeout: 5_000 });
  }
  await textEditorOption.click();
  await expect(page.locator('.monaco-editor .view-lines')).toBeVisible({ timeout: 15_000 });
}

async function openDocBlocksEditor(page: Page, fileName = 'test-doc.md'): Promise<void> {
  const explorer = page.locator('.explorer-folders-view');
  const file = explorer.getByText(fileName);
  await expect(file).toBeVisible({ timeout: 10_000 });
  await file.click();

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

  test('loads the default DocBlocks editor with expected mode tabs and rendered fixture content', async ({
    page,
  }) => {
    await bootVSCode(page);
    await openDocBlocksEditor(page);

    const editor = await getLatestWebviewContent(page);
    await expect(editor.getByRole('toolbar', { name: /formatting toolbar/i })).toBeVisible();
    await expect(editor.getByRole('tab', { name: /write/i })).toBeVisible();
    await expect(editor.getByRole('tab', { name: /source/i })).toBeVisible();
    await expect(editor.getByRole('tab', { name: /use/i })).toBeVisible();
    await expect(editor.getByRole('button', { name: /export document/i })).toBeVisible();
    await expect(editor.locator('body')).toContainText('Test Document');

    await editor.getByRole('tab', { name: /source/i }).click();
    await expect(editor.locator('.monaco-editor')).toBeVisible({ timeout: 15_000 });

    await editor.getByRole('tab', { name: /use/i }).click();
    await expect(editor.locator('body')).toContainText('Test Document', { timeout: 15_000 });
  });

  test('opens a trailing-newline document without authoring or saving a hydration edit', async ({
    page,
  }) => {
    const untouched = 'testing!\n';
    await writeFixture(untouched);
    await bootVSCode(page);
    await openDocBlocksEditor(page);

    const editor = await getLatestWebviewContent(page);
    await expect(editor.locator('body')).toContainText('testing!');
    await page.waitForTimeout(1_000);

    await expect(editor.getByText('Unsaved changes', { exact: true })).toHaveCount(0);
    await expect(editor.getByText(/This file changed outside DocBlocks/)).toHaveCount(0);
    expect(await readFixture()).toBe(untouched);
  });

  test('deletes a trailing-newline document to zero bytes without a self-conflict', async ({
    page,
  }) => {
    await writeFixture('testing!\n\n\n');
    await bootVSCode(page);
    await openDocBlocksEditor(page);

    const editor = await getLatestWebviewContent(page);
    const paragraph = editor.getByText('testing!').first();
    await expect(paragraph).toBeVisible({ timeout: 15_000 });
    await paragraph.click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Backspace');

    await expect(editor.getByText('0 chars', { exact: true })).toBeVisible();
    await page.waitForTimeout(1_000);
    await expect(editor.getByText('Unsaved changes', { exact: true })).toHaveCount(0);
    await expect(editor.getByText(/This file changed outside DocBlocks/)).toHaveCount(0);
  });

  test('opens DocBlocks for VS Code settings from the editor toolbar', async ({ page }) => {
    await bootVSCode(page);
    await openDocBlocksEditor(page);

    const editor = await getLatestWebviewContent(page);
    const settingsButton = editor.getByRole('button', { name: /docblocks settings/i });
    await expect(settingsButton).toBeVisible();
    await settingsButton.click();

    await expect(
      editor.getByRole('dialog', { name: /docblocks for vs code settings/i }),
    ).toBeVisible();
    await expect(editor.getByRole('checkbox', { name: /automatically save files/i })).toBeChecked();
    await expect(editor.getByRole('radio', { name: 'Green' })).toBeVisible();
    await editor.getByRole('button', { name: 'Close' }).click();
    await expect(
      editor.getByRole('dialog', { name: /docblocks for vs code settings/i }),
    ).not.toBeVisible();
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

    await openTextEditorWithOpenWith(page);

    await expect(page.locator('.monaco-editor .view-lines')).toContainText(editSentinel, {
      timeout: 10_000,
    });
  });
});
