// TEMPORARY probe (not a real test): does the VS Code for Web harness persist
// edits back to the fixture file on disk? If it does not, every e2e assertion
// of the form `expect(await readFixture()).toBe(untouched)` is vacuous.
// Uses the BUILT-IN text editor, so DocBlocks is not involved at all.
import { test, expect, type Page } from '@playwright/test';

const fixturePath = 'test-fixtures/test-doc.md';

async function readFixture(): Promise<string> {
  const fs = await import('node:fs/promises');
  return fs.readFile(fixturePath, 'utf8');
}

async function writeFixture(content: string): Promise<void> {
  const fs = await import('node:fs/promises');
  await fs.writeFile(fixturePath, content);
}

async function bootVSCode(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForSelector('.monaco-workbench', { timeout: 30_000 });
  await page.waitForSelector('.activitybar', { timeout: 15_000 });
}

test('probe: does the built-in text editor persist to disk?', async ({ page }) => {
  const before = 'PROBE-ORIGINAL\n';
  await writeFixture(before);
  await bootVSCode(page);

  // Open with the built-in text editor via Open With..., bypassing DocBlocks.
  const explorer = page.locator('.explorer-folders-view');
  const file = explorer.getByText('test-doc.md');
  await expect(file).toBeVisible({ timeout: 10_000 });
  await file.click({ button: 'right' });
  await expect(page.locator('.context-view')).toBeVisible({ timeout: 5_000 });
  const openWith = page.locator('.context-view .action-label').filter({ hasText: 'Open With...' });
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
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('PROBE-ORIGINAL');

  await page.locator('.monaco-editor .view-lines').click();
  await page.keyboard.type('MUTATED');
  await page.waitForTimeout(500);
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('MUTATED');

  await page.keyboard.press('Control+s');
  await page.waitForTimeout(4_000);

  const after = await readFixture();
  console.log('=== PROBE: text editor shows MUTATED; file on disk is: ===');
  console.log(JSON.stringify(after));
  console.log('=== PROBE: disk changed =', after !== before, '===');
});
