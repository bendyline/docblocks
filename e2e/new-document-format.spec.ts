import type { Page } from '@playwright/test';
import { openInitializedSite } from './helpers/site.js';
import { expect, test } from './helpers/test.js';

/**
 * The type last used to create a document in a workspace is that workspace's
 * next default, in both the New document dialog and the explorer's New File
 * form, and survives a reload. Other workspaces keep their own default.
 */

async function switchWorkspace(page: Page, name: string) {
  await page.getByRole('button', { name: /Switch workspace/ }).click();
  await page.getByRole('button', { name, exact: true }).click();
  await expect(
    page.getByRole('button', { name: `Switch workspace, current: ${name}` }),
  ).toBeVisible();
}

async function explorerDefaultType(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'New File', exact: true }).click();
  const type = await page.getByLabel('New file type').inputValue();
  await page.locator('.db-new-item-input').press('Escape');
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
  const dialog = page.getByRole('dialog', { name: 'New document' });
  await expect(dialog.getByLabel('Type')).toHaveValue('markdown');
  await dialog.getByLabel('Type').selectOption('web-static');
  await dialog.getByLabel('Document name').fill('first');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(
    page.locator('.db-tree-row[data-path="first.html"], .db-tree-row[data-path="/first.html"]'),
  ).toBeVisible({
    timeout: 30_000,
  });

  // The next document defaults to the type just used, in both entry points.
  await page.keyboard.press('ControlOrMeta+KeyN');
  await expect(page.getByRole('dialog', { name: 'New document' }).getByLabel('Type')).toHaveValue(
    'web-static',
  );
  await page
    .getByRole('dialog', { name: 'New document' })
    .getByRole('button', { name: 'Cancel' })
    .click();
  expect(await explorerDefaultType(page)).toBe('web-static');

  // Another workspace keeps its own default.
  await switchWorkspace(page, 'My Documents');
  expect(await explorerDefaultType(page)).toBe('markdown');

  // And the choice survives a reload.
  await switchWorkspace(page, 'Static pages');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(
    page.getByRole('button', { name: 'Switch workspace, current: Static pages' }),
  ).toBeVisible({ timeout: 75_000 });
  expect(await explorerDefaultType(page)).toBe('web-static');
});
