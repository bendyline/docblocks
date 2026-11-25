import type { Frame, FrameLocator, Locator } from '@playwright/test';
import { expect } from './test.js';

type Editor = Frame | FrameLocator;

/**
 * The toolbar's one view control. It is named after the view on screen
 * ("View: Write", "View: Slideshow", …) and opens the View menu; those names
 * follow the chosen layout or Use mode, so `data-active-view` is the stable
 * hook for which view is showing.
 */
export function viewButton(editor: Editor): Locator {
  return editor.locator('.squisq-toolbar-view-button');
}

/** Picks a view from one of the View menu's groups, as a user does. */
async function chooseView(editor: Editor, group: 'Edit' | 'Use', name: string): Promise<void> {
  const menu = editor.getByRole('menu', { name: 'View', exact: true });
  await viewButton(editor).click();
  await menu
    .getByRole('group', { name: group, exact: true })
    .getByRole('menuitemradio', { name, exact: true })
    .click();
  await expect(menu).toBeHidden();
}

/** Switch the webview editor to Source, chosen from View › Edit. */
export async function showSource(editor: Editor): Promise<void> {
  await chooseView(editor, 'Edit', 'Source');
  await expect(viewButton(editor)).toHaveAttribute('data-active-view', 'raw');
}

/** Switch the webview editor to a Use mode, chosen from View › Use. */
export async function showUse(editor: Editor, mode = 'Slideshow'): Promise<void> {
  await chooseView(editor, 'Use', mode);
  await expect(viewButton(editor)).toHaveAttribute('data-active-view', 'preview');
}

/** Switch the webview editor to a Write layout, chosen from View › Edit. */
export async function showEdit(editor: Editor, layout: string): Promise<void> {
  await chooseView(editor, 'Edit', layout);
  await expect(viewButton(editor)).toHaveAttribute('data-active-view', 'wysiwyg');
}
