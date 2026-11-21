import type { Locator, Page } from '@playwright/test';
import { expect, test } from './helpers/test.js';
import { openInitializedSite } from './helpers/site.js';

/**
 * Two windows on one workspace are two devices as far as a document is
 * concerned: each holds its own text and saves to the same file. These run the
 * whole path a person sees when both edit: separate edits combine by
 * themselves (with a way back), and edits to the same paragraph ask.
 */

const FILE = 'two-windows.md';

function editorOf(page: Page): Locator {
  return page.getByRole('textbox', { name: new RegExp(`^Edit /?${FILE.replace('.', '\\.')}$`) });
}

async function saved(page: Page): Promise<void> {
  await expect(page.locator('.db-shell')).toHaveAttribute('data-document-status', 'saved', {
    timeout: 15_000,
  });
}

/** Put the caret at the end of the paragraph holding `text` and type after it. */
async function typeAfter(page: Page, text: string, addition: string): Promise<void> {
  await editorOf(page).getByText(text, { exact: false }).first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(addition);
}

/**
 * Make both windows hold unsaved edits at the same moment, which is what two
 * devices do. A window that is not being typed in takes the other's save at
 * once, so `page` keeps typing (and so stays unsaved) while `other` types and
 * saves. When this returns, `page` has finished typing with the other
 * window's version already on disk.
 */
async function editAtTheSameTime(
  page: Page,
  mine: { after: string; add: string },
  other: Page,
  theirs: { after: string; add: string },
): Promise<void> {
  await editorOf(page).getByText(mine.after, { exact: false }).first().click();
  await page.keyboard.press('End');
  // Slow enough to still be typing when the other window's save lands.
  const typing = page.keyboard.type(mine.add, { delay: 180 });
  await typeAfter(other, theirs.after, theirs.add);
  await saved(other);
  await typing;
}

/** Create the document in the first window and open the same one in a second. */
async function openInTwoWindows(page: Page): Promise<Page> {
  await openInitializedSite(page);
  await page.getByRole('button', { name: 'New File', exact: true }).click();
  const name = page.getByRole('textbox', { name: 'New file name' });
  await name.fill(FILE);
  await name.press('Enter');
  const editor = editorOf(page);
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.type('First paragraph.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Second paragraph.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Third paragraph.');
  await saved(page);

  const other = await page.context().newPage();
  await other.goto(page.url(), { waitUntil: 'domcontentloaded' });
  await expect(editorOf(other)).toContainText('Third paragraph.', { timeout: 75_000 });
  await saved(other);
  return other;
}

test('shows another window’s saved edits without being touched', async ({ page }) => {
  const other = await openInTwoWindows(page);

  // Only the first window is used from here on; the second just watches.
  await page.bringToFront();
  await typeAfter(page, 'Second paragraph.', ' Added in the first window.');
  await saved(page);

  await expect(editorOf(other)).toContainText('Second paragraph. Added in the first window.', {
    timeout: 15_000,
  });
  // A clean window simply takes the newer text: nothing to decide, nothing set aside.
  await expect(other.getByRole('button', { name: 'Compare versions' })).toHaveCount(0);
  await expect(other.locator('.db-document-versions-notice')).toHaveCount(0);
  await other.close();
});

test('combines separate edits from two windows, and Undo keeps the other version for review', async ({
  page,
}) => {
  const other = await openInTwoWindows(page);

  // This window changes the first paragraph while the other changes the third.
  await editAtTheSameTime(page, { after: 'First paragraph.', add: ' Changed here.' }, other, {
    after: 'Third paragraph.',
    add: ' Changed in the other window.',
  });

  const notice = page.locator('.db-document-session-notice');
  await expect(notice).toContainText(
    'Safely combined your edits with changes from another device.',
    {
      timeout: 20_000,
    },
  );
  // Both edits are in the document, and nothing asked the user to choose.
  await expect(editorOf(page)).toContainText('First paragraph. Changed here.');
  await expect(editorOf(page)).toContainText('Third paragraph. Changed in the other window.');
  await expect(page.getByRole('button', { name: 'Compare versions' })).toHaveCount(0);
  await saved(page);

  // Undo puts back this window's own text...
  await notice.getByRole('button', { name: 'Undo' }).click();
  await expect(editorOf(page)).not.toContainText('Changed in the other window.');
  await expect(editorOf(page)).toContainText('First paragraph. Changed here.');
  await saved(page);

  // ...and the other window's version is not lost: it waits for review.
  const waiting = page.locator('.db-document-versions-notice');
  await expect(waiting).toContainText('1 other version to review', { timeout: 15_000 });
  await expect(
    page.locator(`.db-tree-row[data-path$="${FILE}"] .db-git-badge--versions`),
  ).toHaveText('1');

  await waiting.getByRole('button', { name: 'Review' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review other versions' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('region', { name: 'The document now preview' })).toContainText(
    'First paragraph. Changed here.',
  );
  const version = dialog.getByRole('region', { name: 'Edits that were set aside preview' });
  await expect(version).toContainText('Third paragraph. Changed in the other window.');
  await expect(
    dialog
      .getByRole('region', { name: 'Differences' })
      .locator('.monaco-diff-editor .view-line')
      .first(),
  ).toBeVisible({ timeout: 20_000 });

  await dialog.getByRole('button', { name: 'Use this version' }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(editorOf(page)).toContainText('Third paragraph. Changed in the other window.');
  await expect(editorOf(page)).not.toContainText('Changed here.');
  await expect(waiting).toHaveCount(0);
  await saved(page);
  await other.close();
});

test('asks when two windows change the same paragraph, and lets the user leave without losing either', async ({
  page,
}) => {
  const other = await openInTwoWindows(page);

  await editAtTheSameTime(page, { after: 'Second paragraph.', add: ' Mine, typed here.' }, other, {
    after: 'Second paragraph.',
    add: ' Theirs.',
  });

  // Edits to the same paragraph are never joined without a person looking.
  const compare = page.getByRole('button', { name: 'Compare versions' });
  await expect(compare).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.db-document-session-notice')).toHaveCount(0);

  // Combining by hand is on offer, starting from this window's text.
  await compare.click();
  const comparison = page.getByRole('dialog', { name: 'Compare document versions' });
  await expect(comparison).toBeVisible();
  await comparison.getByRole('button', { name: 'Combine by hand' }).click();
  const combining = comparison.getByRole('region', { name: 'Combined version' });
  await expect(combining.locator('.monaco-diff-editor .view-line').first()).toBeVisible({
    timeout: 20_000,
  });
  await comparison.getByRole('button', { name: 'Back to comparing' }).click();
  await comparison.getByRole('button', { name: 'Decide later' }).click();
  await expect(comparison).toBeHidden();

  // Leaving is allowed: the unsaved text is set aside, the saved file is kept.
  await page
    .locator('.db-tree-row[data-path="Welcome.md"], .db-tree-row[data-path="/Welcome.md"]')
    .click();
  await expect(page.locator('.db-document-session-notice')).toContainText(
    `Your unsaved version of ${FILE} was set aside.`,
    { timeout: 15_000 },
  );
  await expect(page.getByRole('textbox', { name: /^Edit \/?Welcome\.md$/ })).toBeVisible();

  // Coming back shows the saved file, and the set-aside text waiting for review.
  await page.locator(`.db-tree-row[data-path$="${FILE}"]`).click();
  await expect(editorOf(page)).toContainText('Second paragraph. Theirs.', { timeout: 15_000 });
  const waiting = page.locator('.db-document-versions-notice');
  await expect(waiting).toContainText('1 other version to review', { timeout: 15_000 });
  await waiting.getByRole('button', { name: 'Review' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review other versions' });
  await expect(
    dialog.getByRole('region', { name: 'Edits that were set aside preview' }),
  ).toContainText('Second paragraph. Mine, typed here.');

  // Keep both: the set-aside text becomes its own document beside this one.
  await dialog.getByRole('button', { name: 'Keep both' }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(
    page.locator('.db-tree-row[data-path$="two-windows (other version).md"]'),
  ).toBeVisible({ timeout: 15_000 });
  await expect(waiting).toHaveCount(0);
  await expect(editorOf(page)).toContainText('Second paragraph. Theirs.');
  await other.close();
});
