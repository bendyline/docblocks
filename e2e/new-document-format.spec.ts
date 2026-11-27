import type { Page } from '@playwright/test';
import { openInitializedSite } from './helpers/site.js';
import { createDocument, newDocumentGallery } from './helpers/new-document.js';
import { expect, test } from './helpers/test.js';

/**
 * The type last used to create a document in a workspace is that workspace's
 * next default in the New document gallery, however it is opened, and
 * survives a reload. Other workspaces keep their own default.
 */

async function switchWorkspace(page: Page, name: string) {
  await page.getByRole('button', { name: /Switch workspace/ }).click();
  await page.getByRole('button', { name, exact: true }).click();
  await expect(
    page.getByRole('button', { name: `Switch workspace, current: ${name}` }),
  ).toBeVisible();
}

/** The type chip the gallery opens with, from the file list's New File. */
async function explorerDefaultType(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'New File', exact: true }).click();
  const gallery = newDocumentGallery(page);
  const type = await gallery.getByRole('radio', { checked: true }).innerText();
  await gallery.getByRole('button', { name: 'Cancel' }).click();
  return type;
}

test('remembers the last document type per workspace', async ({ page }) => {
  await openInitializedSite(page);

  await page.getByRole('button', { name: /Switch workspace/ }).click();
  await page.getByRole('button', { name: 'New Workspace' }).click();
  await page.getByLabel('Workspace name').fill('Static pages');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Switch workspace, current: Static pages' }),
  ).toBeVisible();

  // First document: Markdown is the default until something else is used.
  await page
    .locator('.db-workspace-empty-content')
    .getByRole('button', { name: 'New document' })
    .click();
  await expect(newDocumentGallery(page).getByRole('radio', { checked: true })).toHaveText(
    'Markdown',
  );
  await createDocument(page, 'first.html', { type: 'Static web page', openGallery: true });
  await expect(
    page.locator('.db-tree-row[data-path="first.html"], .db-tree-row[data-path="/first.html"]'),
  ).toBeVisible({
    timeout: 30_000,
  });

  // The next document defaults to the type just used, in both entry points.
  await page.keyboard.press('ControlOrMeta+KeyN');
  await expect(newDocumentGallery(page).getByRole('radio', { checked: true })).toHaveText(
    'Static web page',
  );
  await newDocumentGallery(page).getByRole('button', { name: 'Cancel' }).click();
  expect(await explorerDefaultType(page)).toBe('Static web page');

  // Another workspace keeps its own default.
  await switchWorkspace(page, 'My Documents');
  expect(await explorerDefaultType(page)).toBe('Markdown');

  // And the choice survives a reload.
  await switchWorkspace(page, 'Static pages');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(
    page.getByRole('button', { name: 'Switch workspace, current: Static pages' }),
  ).toBeVisible({ timeout: 75_000 });
  expect(await explorerDefaultType(page)).toBe('Static web page');
});
