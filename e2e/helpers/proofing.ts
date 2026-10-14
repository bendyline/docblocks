import type { Page } from '@playwright/test';
import { expect } from './test.js';
import { openInitializedSite } from './site.js';

/**
 * Exercise the shipped welcome fixture through the real worker. A green status
 * alone is insufficient: setup becomes ready before the first lint finishes.
 * Wait for a deliberately inserted spelling AND spacing error, remove that
 * insertion, then wait for the clean result before inspecting/capturing it.
 */
export async function openProofedWelcome(
  page: Page,
  view: 'Write' | 'Source' = 'Write',
  acceptedWord?: string,
): Promise<void> {
  await openInitializedSite(page);
  await page.getByRole('tab', { name: view, exact: true }).click();
  const editor =
    view === 'Write'
      ? page.locator('.tiptap[contenteditable="true"]')
      : page.locator('.monaco-editor textarea').first();
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await editor.focus();
  // Monaco binds shortcuts to the emulated browser platform. Desktop Chrome
  // advertises Windows even when the runner is on macOS; using the runner's
  // modifier then leaves the caret above frontmatter instead of at the end.
  const modifier =
    view === 'Source'
      ? await page.evaluate(() => (navigator.userAgent.includes('Macintosh') ? 'Meta' : 'Control'))
      : process.platform === 'darwin'
        ? 'Meta'
        : 'Control';
  await page.keyboard.press(`${modifier}+Home`);
  // Source frontmatter must stay at the beginning of the document.
  if (view === 'Source') await page.keyboard.press(`${modifier}+End`);
  const heading = page.locator('.tiptap h1').first();
  const before = view === 'Write' ? await heading.textContent() : null;
  const probe = `${acceptedWord ? `${acceptedWord} found` : 'This is'} teh typo. There is  extra space.`;
  await page.keyboard.insertText(view === 'Source' ? `\n\n${probe}\n` : `${probe} `);
  const status = page.locator('.squisq-proof-status');
  await expect(status).toHaveText(/\d+ issues?/, { timeout: 60_000 });
  await status.click();
  const panel = page.getByRole('complementary', { name: 'Proofing findings' });
  await expect(panel.locator('.squisq-proof-panel-excerpt', { hasText: /^teh$/ })).toBeVisible();
  await expect(panel.locator('.squisq-proof-panel-message', { hasText: /2 spaces/ })).toBeVisible();
  // Exactly these two errors: brand names, code, and saved user vocabulary stay
  // accepted while both proofing categories remain useful.
  await expect(panel.locator('.squisq-proof-panel-row')).toHaveCount(2);
  await editor.focus();
  if (view === 'Write') {
    await page.keyboard.press(`${modifier}+z`);
  } else {
    // Remove the exact appended characters through Monaco's normal input.
    await page.keyboard.press(`${modifier}+End`);
    await page.keyboard.down('Shift');
    for (let i = 0; i < probe.length + 3; i += 1) await page.keyboard.press('ArrowLeft');
    await page.keyboard.up('Shift');
    await page.keyboard.press('Backspace');
  }
  if (before !== null) await expect(heading).toHaveText(before);
  await expect(panel.getByText('No issues found.', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(status).toHaveText('✓ Proofing');
  await expect(page.locator('.squisq-proof-underline')).toHaveCount(0);
  await page.keyboard.press(`${modifier}+Home`);
  await editor.blur();
}
