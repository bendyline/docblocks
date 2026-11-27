import type { Page } from '@playwright/test';
import { expect, test } from './helpers/test.js';
import { selectUseMode, selectWriteMode } from './helpers/toolbar.js';

/**
 * View › Edit › Study cards on the site, which has no AI: the document's
 * sections beside their cards, a card added by hand into the document, then
 * studied in Use › Flashcards. The view is Squisq's; the site only mounts it.
 */

async function openWelcome(page: Page): Promise<void> {
  await page.goto('/');
  const shell = page.locator('.db-shell');
  await expect(shell).toBeVisible();
  const tour = page.getByRole('button', { name: 'Tour the welcome document' });
  const startWriting = page.locator('.db-welcome-gateway-cta');
  await expect(tour.or(startWriting).first()).toBeVisible({ timeout: 30_000 });
  await ((await tour.count()) > 0 ? tour : startWriting).click();
  await expect(page.locator('.squisq-toolbar')).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => decodeURIComponent(new URL(page.url()).hash), { timeout: 30_000 })
    .toMatch(/\/Welcome\.md$/i);
  if ((await shell.getAttribute('data-db-layout')) === 'single-pane')
    await expect(shell).toHaveAttribute('data-db-drawer', 'closed');
}

async function openStudyCards(page: Page) {
  await selectWriteMode(page, 'Study cards');
  const view = page.getByRole('region', { name: 'Study cards', exact: true });
  await expect(view.getByRole('status').first()).toContainText('cards in', { timeout: 15_000 });
  return view;
}

test.describe('Study cards on the site', () => {
  test('adds a card by hand and studies it, with no AI to offer', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openWelcome(page);
    const view = await openStudyCards(page);
    await expect(view.getByRole('button', { name: 'Generate for this section' })).toHaveCount(0);
    await expect(view.getByRole('navigation', { name: 'Sections' })).toBeVisible();

    await view.getByRole('button', { name: 'Add flashcard' }).click();
    const form = view.getByRole('article', { name: 'New flashcard' });
    await form.getByRole('textbox', { name: 'Question' }).fill('What does DocBlocks store?');
    await form.getByRole('textbox', { name: 'Answer' }).fill('Plain Markdown files.');
    await form.getByRole('button', { name: 'Save card' }).click();
    await expect(view.getByRole('status').first()).toContainText('1 card in 1 section');

    await selectUseMode(page, 'Flashcards');
    await expect(page.getByRole('heading', { name: 'What does DocBlocks store?' })).toBeVisible();
    await page.getByRole('button', { name: 'Reveal', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Answer' })).toContainText(
      'Plain Markdown files.',
    );
  });

  test('folds the section list into a picker in a narrow panel', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 664 });
    await openWelcome(page);
    const view = await openStudyCards(page);
    await expect(view.getByRole('combobox', { name: 'Section' })).toBeVisible();
    await expect(view.getByRole('navigation', { name: 'Sections' })).toBeHidden();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
