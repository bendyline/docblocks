import type { Locator, Page } from '@playwright/test';
import { expect } from './test.js';

/** The editor's three views, as the view button's `data-active-view` names them. */
export type EditorView = 'wysiwyg' | 'raw' | 'preview';

/** The View menu's Edit views: the Write layouts, and Source. */
export type EditMode = 'Write' | 'Source' | 'Blocks' | 'Timeline' | 'Summaries' | 'Study cards';

/** The View menu's Use views. Narrate is listed only where the host allows it. */
export type UseMode =
  | 'Slideshow'
  | 'Video'
  | 'Page'
  | 'Document'
  | 'Dashboard'
  | 'Narrate'
  | 'Flashcards';

const VIEW_SHORTCUTS: Record<EditorView, string> = { wysiwyg: '1', raw: '2', preview: '3' };

/**
 * The toolbar's one view control. It is named after the view on screen
 * ("View: Write", "View: Slideshow", …) and opens the View menu. Those names
 * follow the chosen layout or Use mode, so `data-active-view` is the stable
 * hook for which view is showing.
 */
export function viewButton(scope: Page | Locator): Locator {
  return scope.locator('.squisq-toolbar-view-button');
}

/**
 * Switch views the way the keyboard does (Ctrl/Cmd+Shift+1/2/3, handled on
 * the editor shell), which returns to each view as it was left: Write in its
 * layout, Use in its mode. Going through the keyboard rather than the menu
 * keeps a re-rendering toolbar from closing a menu under the click.
 */
export async function switchView(scope: Page | Locator, view: EditorView): Promise<void> {
  const button = viewButton(scope);
  if ((await button.getAttribute('data-active-view')) !== view) {
    await button.press(`ControlOrMeta+Shift+Digit${VIEW_SHORTCUTS[view]}`);
  }
  await expect(button).toHaveAttribute('data-active-view', view);
}

/** Switch to Write, in whichever layout it was last in (Write, Blocks, …). */
export async function showWriteView(scope: Page | Locator): Promise<void> {
  await switchView(scope, 'wysiwyg');
}

/** Switch to Source, the whole file as Markdown. */
export async function showSourceView(scope: Page | Locator): Promise<void> {
  await switchView(scope, 'raw');
}

/** Switch to Use, in whichever mode it was last in (Slideshow, Page, …). */
export async function showUseView(scope: Page | Locator): Promise<void> {
  await switchView(scope, 'preview');
}

/**
 * Open the View menu from the view button. A resize or a late re-render can
 * close a menu opened in the same frame, so each attempt clicks on a short
 * limit and the next one looks again; the button toggles, so only click while
 * the menu is closed.
 */
export async function openViewMenu(page: Page): Promise<Locator> {
  const menu = page.getByRole('menu', { name: 'View', exact: true });
  const timeout = 2_000;
  await expect(async () => {
    if (!(await menu.isVisible())) await viewButton(page).click({ timeout });
    await expect(menu).toBeVisible({ timeout });
  }).toPass({ timeout: 30_000 });
  return menu;
}

/** Picks a Write layout, or Source, from View › Edit. It also enters that view. */
export async function selectWriteMode(page: Page, mode: EditMode): Promise<void> {
  const menu = await openViewMenu(page);
  await menu
    .getByRole('group', { name: 'Edit', exact: true })
    .getByRole('menuitemradio', { name: mode, exact: true })
    .click();
  await expect(menu).toBeHidden();
}

/** Picks a Use mode from View › Use. It also enters Use. */
export async function selectUseMode(page: Page, mode: UseMode): Promise<void> {
  const menu = await openViewMenu(page);
  await menu
    .getByRole('group', { name: 'Use', exact: true })
    .getByRole('menuitemradio', { name: mode, exact: true })
    .click();
  await expect(menu).toBeHidden();
}

/**
 * Close the View menu. Its toggles (panes, block tags, the Files row) leave
 * it open so several can change in one visit.
 */
export async function closeViewMenu(page: Page): Promise<void> {
  const menu = page.getByRole('menu', { name: 'View', exact: true });
  if (await menu.isVisible()) await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
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
 * persistent tags in the View menu so the ordinary click can wait for
 * layout to settle without depending on that transient focus.
 */
export async function openBlockTypePicker(page: Page): Promise<Locator> {
  const menu = await openViewMenu(page);
  const alwaysShow = menu
    .getByRole('group', { name: 'Show block tags', exact: true })
    .getByRole('menuitemradio', { name: 'Always show', exact: true });
  await alwaysShow.click();
  await expect(alwaysShow).toHaveAttribute('aria-checked', 'true');
  await closeViewMenu(page);

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
