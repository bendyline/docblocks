import type { Locator, Page } from '@playwright/test';
import { expect } from './test.js';

/**
 * Switch to the Write view. Clicking the tab you're already on opens its
 * Write mode menu instead, which then sits over whatever the test clicks
 * next, so only click when another view is selected. `data-view` is the
 * stable hook: the tab's label follows the Write mode (Write, Blocks,
 * Timeline).
 */
export async function showWriteView(scope: Page | Locator): Promise<void> {
  const tab = scope.locator('[role="tab"][data-view="wysiwyg"]');
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

/** Picks a Write layout from the menu beside the Write tab; it also enters Write. */
export async function selectWriteMode(
  page: Page,
  mode: 'Write' | 'Blocks' | 'Timeline',
): Promise<void> {
  await page.getByRole('button', { name: 'Choose Write mode', exact: true }).click();
  const item = page
    .getByRole('menu', { name: 'Write mode', exact: true })
    .getByRole('menuitemradio', { name: mode, exact: true });
  await item.click();
  await expect(item).toBeHidden();
}

/**
 * Show the Attachments panel, wherever the toolbar put its toggle: inline,
 * or under More actions once the row is too narrow to keep it.
 *
 * There is no settled moment to wait for. A new toolbar displays every control
 * and then collapses them over several measure passes, so the toggle can pass
 * any check and be `display: none` before the click lands, and an unlimited
 * click then waits out the test for a button that is not coming back. Each
 * attempt therefore clicks on a short limit and the next one looks again.
 * `aria-pressed` tracks the panel wherever the toggle is, so a retry cannot
 * close it.
 */
export async function openAttachments(page: Page): Promise<void> {
  const toolbar = page.locator('.squisq-toolbar');
  const toggle = toolbar.locator('.squisq-toolbar-files-toggle');
  const menu = page.locator('.squisq-toolbar-overflow-menu');
  const timeout = 2_000;

  await expect(async () => {
    if ((await toggle.getAttribute('aria-pressed', { timeout })) === 'true') return;
    if (await toggle.isVisible()) {
      await toggle.click({ timeout });
    } else {
      if (!(await menu.isVisible())) {
        await toolbar.locator('.squisq-toolbar-overflow-trigger').click({ timeout });
      }
      await menu.getByRole('button', { name: /^Show attachments/ }).click({ timeout });
    }
    await expect(toggle).toHaveAttribute('aria-pressed', 'true', { timeout });
  }).toPass({ timeout: 30_000 });
  await expect(page.locator('.squisq-media-bin')).toBeVisible();
}

/**
 * Open the first heading's picker for appearance assertions. The default
 * selected/hovered tags disappear whenever the editor loses focus. Choose
 * persistent tags through View options so the ordinary click
 * can wait for layout to settle without depending on that transient focus.
 */
export async function openBlockTypePicker(page: Page): Promise<Locator> {
  const viewOptions = page.getByRole('button', { name: 'View options', exact: true });
  await viewOptions.click();
  const alwaysShow = page
    .getByRole('group', { name: 'Show block tags', exact: true })
    .getByRole('menuitemradio', { name: 'Always show', exact: true });
  await alwaysShow.click();
  await expect(alwaysShow).toHaveAttribute('aria-checked', 'true');
  await viewOptions.click();
  await expect(page.getByRole('menu', { name: 'View options', exact: true })).toBeHidden();

  const heading = page.locator('.tiptap.ProseMirror').locator('h1, h2, h3').first();
  await heading.locator('.squisq-template-badge').first().click();
  const dialog = page.locator(
    '.squisq-template-gallery-dialog:has([data-squisq-template-gallery-portal])',
  );
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * Squisq's Insert control, wherever the toolbar put it: the inline `+`
 * button, or the `Insert...` entry in the More actions menu once the row is
 * too narrow to keep it. Newer Squisq collapses Insert last; older releases
 * collapsed it first. Tests that only need Insert should not care which.
 */
export async function openInsertMenu(page: Page): Promise<void> {
  const toolbar = page.locator('.squisq-toolbar');
  const inline = toolbar
    .locator('.squisq-toolbar-actions')
    .getByRole('button', { name: 'Insert', exact: true });
  const more = toolbar.locator('.squisq-toolbar-overflow-trigger');

  // Before the toolbar's width measurement runs, a button that is about to
  // collapse can still read as visible but sit clipped past the row's edge.
  // Wait for a settled state: either the ··· trigger is up, or Insert sits
  // wholly inside the actions row.
  await expect
    .poll(async () => {
      if (await more.isVisible()) return true;
      return inline.evaluate((button) => {
        const row = button.closest('.squisq-toolbar-actions')?.getBoundingClientRect();
        const rect = button.getBoundingClientRect();
        return (
          !!row &&
          rect.width > 0 &&
          getComputedStyle(button).visibility !== 'hidden' &&
          rect.right <= row.right
        );
      });
    })
    .toBe(true);

  if (await more.isVisible()) {
    await more.click();
    const fromMenu = page
      .locator('.squisq-toolbar-overflow-menu')
      .getByRole('button', { name: 'Insert...' });
    if (await fromMenu.isVisible()) {
      await fromMenu.click();
      await expect(page.locator('.squisq-insert-menu').first()).toBeVisible();
      return;
    }
    await more.click();
  }
  await inline.click();
  await expect(page.locator('.squisq-insert-menu').first()).toBeVisible();
}

/** Each document action's own toolbar button, by accessible name. */
const DOCUMENT_ACTION_BUTTONS = {
  AI: 'AI actions',
  Speech: 'Speech',
  Git: 'Git actions',
  Export: 'Export and share',
} as const;

/**
 * Open the menu of one of the toolbar's document actions (AI, Speech, Git or
 * Export) wherever the toolbar put it: behind its own button, or behind its
 * row in the Document actions menu Squisq folds them all into when the row
 * runs short. The caller then picks a `menuitem` as usual.
 *
 * As with the Attachments toggle, there is no settled moment to wait for: a
 * new toolbar lays every control out, then folds the group a measure pass
 * later, so a button can pass a check and be gone before the click lands.
 * Each attempt clicks on a short limit and the next one looks again.
 */
export async function openDocumentAction(
  page: Page,
  action: keyof typeof DOCUMENT_ACTION_BUTTONS,
): Promise<void> {
  const toolbar = page.locator('.squisq-toolbar');
  const button = toolbar.getByRole('button', { name: DOCUMENT_ACTION_BUTTONS[action] });
  const folded = toolbar.getByRole('button', { name: 'Document actions', exact: true });
  const foldedMenu = page.locator('.squisq-toolbar-document-menu');
  const open = page
    .getByRole('menu', { name: DOCUMENT_ACTION_BUTTONS[action] })
    .or(page.locator(`.squisq-toolbar-document-menu[aria-label="${action}"]`))
    .first();
  const timeout = 2_000;

  await expect(async () => {
    if (await open.isVisible()) return;
    if (await button.isVisible()) {
      await button.click({ timeout });
    } else {
      if (!(await foldedMenu.isVisible())) await folded.click({ timeout });
      await foldedMenu.getByRole('menuitem', { name: action, exact: true }).click({ timeout });
    }
    await expect(open).toBeVisible({ timeout });
  }).toPass({ timeout: 30_000 });
}

/** Squisq's own document actions, each a single command rather than a menu. */
type SquisqDocumentAction = 'Document settings' | 'Custom layouts' | 'Version history';

/**
 * Run one of Squisq's own document actions wherever the toolbar put it: its
 * button in the document-actions group, or its row in the folded Document
 * actions menu. Retried on short limits for the same reason as
 * `openDocumentAction`; `opened` is what the action shows, and confirms it ran.
 */
export async function chooseDocumentAction(
  page: Page,
  action: SquisqDocumentAction,
  opened: Locator,
): Promise<void> {
  const toolbar = page.locator('.squisq-toolbar');
  const group = toolbar.locator('.squisq-toolbar-document-actions');
  const button = group.getByRole('button', { name: action, exact: true });
  const folded = toolbar.getByRole('button', { name: 'Document actions', exact: true });
  const foldedMenu = page.locator('.squisq-toolbar-document-menu');
  const timeout = 2_000;

  await expect(async () => {
    if (await opened.isVisible()) return;
    if (await button.isVisible()) {
      await button.click({ timeout });
    } else {
      if (!(await foldedMenu.isVisible())) await folded.click({ timeout });
      await foldedMenu.getByRole('menuitem', { name: action, exact: true }).click({ timeout });
    }
    await expect(opened).toBeVisible({ timeout });
  }).toPass({ timeout: 30_000 });
}

/**
 * Close a document action's menu, wherever it opened. Escape closes a
 * control's own dropdown; in the folded menu the first Escape steps back from
 * a control's items to the top level and the next one closes it.
 */
export async function closeDocumentActionMenus(page: Page): Promise<void> {
  const menus = page.locator('.squisq-toolbar-document-menu, .db-toolbar-menu-dropdown');
  await expect(async () => {
    if ((await menus.filter({ visible: true }).count()) > 0) await page.keyboard.press('Escape');
    await expect(menus.filter({ visible: true })).toHaveCount(0, { timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
}
