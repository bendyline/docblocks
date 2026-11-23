/**
 * Creating a document the way a person does: New File (or any New document
 * entry) opens the gallery, a starter card creates the document, and it is
 * named in the toolbar's title field, which has focus with the starting name
 * selected. Enter renames it and puts the caret in the document.
 */

import type { Locator, Page } from '@playwright/test';
import { expect } from './test.js';

export interface CreateDocumentOptions {
  /** The gallery card to start from. */
  starter?: string;
  /** The type chip to pick first, e.g. `Word`; the remembered type otherwise. */
  type?: string;
  /**
   * Open the gallery yourself (the welcome card, a shortcut, a menu) before
   * calling; by default this presses the file list's New File.
   */
  openGallery?: boolean;
  /**
   * Remove everything, title included, once the document is named: for a
   * test that needs a document with nothing in it.
   */
  empty?: boolean;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The gallery, open. */
export function newDocumentGallery(page: Page): Locator {
  return page.getByRole('dialog', { name: 'New document' });
}

/** The toolbar's title field, where a new document is named. */
export function documentTitleField(page: Page): Locator {
  return page.getByRole('textbox', { name: 'Rename document' });
}

/**
 * Create a document and name it `fileName` (`notes.md`, or a bare name for
 * Markdown), and resolve with its Write editor once the caret is in it.
 */
export async function createDocument(
  page: Page,
  fileName: string,
  { starter = 'Blank', type, openGallery = false, empty = false }: CreateDocumentOptions = {},
): Promise<Locator> {
  if (!openGallery) await page.getByRole('button', { name: 'New File', exact: true }).click();
  const gallery = newDocumentGallery(page);
  await expect(gallery).toBeVisible();
  if (type) await gallery.getByRole('radio', { name: type, exact: true }).click();
  await gallery.getByRole('button', { name: starter, exact: true }).click();
  await expect(gallery).toBeHidden();

  const title = documentTitleField(page);
  await expect(title).toBeFocused({ timeout: 15_000 });
  const markdown = !type || type === 'Markdown';
  const stem = markdown ? fileName.replace(/\.md$/i, '') : fileName.replace(/\.[^.]+$/, '');
  await title.fill(stem);
  await title.press('Enter');

  // A rendered document (Word, a web page) is edited through its hidden
  // Markdown companion, and its editor is named after that file. Renaming
  // moves the companion folder but keeps the file inside it as it was.
  const source = markdown
    ? escapeRegExp(`${stem}.md`)
    : `${escapeRegExp(`${stem}_files/`)}[^/]+\\.md`;
  const editor = page.getByRole('textbox', {
    name: new RegExp(`^Edit /?(?:.*/)?${source}$`),
  });
  await expect(editor).toBeVisible({ timeout: 15_000 });
  // The caret goes in once the renamed document has reopened.
  await expect(editor).toBeFocused({ timeout: 15_000 });
  if (empty) {
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Delete');
    await expect(editor.locator('h1')).toHaveCount(0);
  }
  return editor;
}
