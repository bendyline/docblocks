import type { Locator, Page } from '@playwright/test';
import { openInitializedSite } from './helpers/site.js';
import { expect, test } from './helpers/test.js';

/**
 * Quick Jot at the bottom of the left pane: a jot becomes a document in the
 * Unfiled drawer, a task, or a line in today's journal entry, with dropped
 * pictures kept beside it. Touch layouts are in adaptive-quick-jot.spec.ts.
 */

/** A 1×1 PNG. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function quickJot(page: Page) {
  return page.getByRole('region', { name: 'Quick Jot' });
}

function places(page: Page) {
  return page.getByRole('navigation', { name: 'Home and lists' });
}

/** Drop files from outside the app, as a drag from Finder or Explorer would. */
async function dropFiles(
  page: Page,
  target: Locator,
  files: readonly { name: string; type: string; base64: string }[],
): Promise<void> {
  const dataTransfer = await page.evaluateHandle((list) => {
    const transfer = new DataTransfer();
    for (const file of list) {
      const bytes = Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0));
      transfer.items.add(new File([bytes], file.name, { type: file.type }));
    }
    return transfer;
  }, files);
  await target.dispatchEvent('dragenter', { dataTransfer });
  await target.dispatchEvent('dragover', { dataTransfer });
  await target.dispatchEvent('drop', { dataTransfer });
}

async function openSettings(page: Page) {
  await page.locator('.db-app-menu-btn').click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('a jot becomes a document in the Unfiled drawer, with a dropped picture beside it', async ({
  page,
}) => {
  await openInitializedSite(page);
  const jot = quickJot(page);
  await expect(jot).toBeVisible();
  // An empty box offers only ways to fill it; the make buttons come with content.
  const makeInto = jot.getByRole('group', { name: 'Make the jot into' });
  await expect(jot.getByRole('button', { name: 'Paste from clipboard' })).toBeVisible();
  await expect(makeInto).toHaveCount(0);

  const field = jot.getByLabel('Jot something down');
  await field.fill('Venue ideas\nThe barn by the river');
  await expect(makeInto).toBeVisible();
  // With no tasks folder or journal yet, a jot can only become a document.
  await expect(jot.getByRole('button', { name: 'New task from jot' })).toHaveCount(0);
  await expect(jot.getByRole('button', { name: 'Add jot to journal' })).toHaveCount(0);
  await dropFiles(page, jot, [{ name: 'venue.png', type: 'image/png', base64: PNG_BASE64 }]);
  const attached = jot.getByRole('list', { name: 'Attached files' });
  await expect(attached.getByRole('listitem')).toHaveText(['venue.png']);

  await jot.getByRole('button', { name: 'New document from jot' }).click();
  await expect(page).toHaveURL(/Unfiled(%2F|\/)Venue%20ideas\.md$/, { timeout: 15_000 });
  await expect(field).toHaveValue('');
  await expect(attached).toHaveCount(0);
  // The picture was written beside the note and shows in it.
  await expect(page.locator('.squisq-wysiwyg-container img').first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator('.squisq-wysiwyg-container')).toContainText('The barn by the river');
});

test('a journal jot keeps its lines in one entry, and Ctrl+Enter makes a document', async ({
  page,
}) => {
  await openInitializedSite(page);
  await places(page).getByRole('button', { name: 'Home' }).click();
  await page
    .getByRole('region', { name: 'Home' })
    .getByRole('button', { name: 'Start a journal' })
    .click();
  const jot = quickJot(page);
  const toJournal = jot.getByRole('button', { name: 'Add jot to journal' });
  const field = jot.getByLabel('Jot something down');
  await field.fill('Site visit\nroof is fine');
  await expect(toJournal).toBeVisible({ timeout: 15_000 });
  await toJournal.click();
  await expect(field).toHaveValue('');

  await places(page).getByRole('button', { name: 'Journal' }).click();
  await page.getByRole('button', { name: "Open today's entry" }).click();
  // The second line is a bullet nested inside the entry's own item.
  const entry = page.locator('.squisq-wysiwyg-container li', { hasText: 'Site visit' });
  await expect(entry).toHaveCount(1, { timeout: 15_000 });
  await expect(entry.locator('li')).toHaveText('roof is fine');

  await field.fill('Quick thought about pricing');
  await field.press('ControlOrMeta+Enter');
  await expect(page).toHaveURL(/Unfiled(%2F|\/)Quick%20thought%20about%20pricing\.md$/, {
    timeout: 15_000,
  });
  await expect(field).toHaveValue('');
});

test('fits the narrowest left pane, its buttons on one row', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openInitializedSite(page);
  await places(page).getByRole('button', { name: 'Home' }).click();
  const home = page.getByRole('region', { name: 'Home' });
  await home.getByRole('button', { name: 'Add a tasks folder' }).click();
  await places(page).getByRole('button', { name: 'Home' }).click();
  await home.getByRole('button', { name: 'Start a journal' }).click();
  const jot = quickJot(page);
  // The make buttons show once there is something to make.
  await jot.getByLabel('Jot something down').fill('Groceries');
  await expect(jot.getByRole('button', { name: 'Add jot to journal' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(jot.getByRole('button', { name: 'New task from jot' })).toBeVisible();

  const layout = await jot.evaluate((section) => {
    const sidebar = section.closest('aside')!.getBoundingClientRect();
    const buttons = [...section.querySelectorAll('.db-quick-jot-btn')].map((button) =>
      button.getBoundingClientRect(),
    );
    return {
      sidebarWidth: Math.round(sidebar.width),
      overflow: section.scrollWidth - section.clientWidth,
      rows: new Set(buttons.map((box) => Math.round(box.top))).size,
      count: buttons.length,
      inside: buttons.every((box) => box.right <= sidebar.right && box.left >= sidebar.left),
    };
  });
  expect(layout.sidebarWidth).toBe(320);
  expect(layout).toMatchObject({ rows: 1, count: 4, inside: true });
  expect(layout.overflow).toBeLessThanOrEqual(0);

  // There is room to say what each button makes...
  const labels = jot.locator('.db-quick-jot-btn-label');
  await expect(labels).toHaveText(['Doc', 'Task', 'Journal']);
  for (const label of await labels.all()) await expect(label).toBeVisible();

  // ...until the pane is squeezed, when the buttons go back to icons on one row.
  await jot.evaluate((section) => {
    section.closest('aside')!.style.width = '200px';
  });
  await expect(labels.first()).toBeHidden();
  const squeezed = await jot.evaluate((section) => {
    const box = section.getBoundingClientRect();
    const buttons = [...section.querySelectorAll('.db-quick-jot-btn')].map((button) =>
      button.getBoundingClientRect(),
    );
    return {
      rows: new Set(buttons.map((b) => Math.round(b.top))).size,
      inside: buttons.every((b) => b.right <= box.right && b.left >= box.left),
    };
  });
  expect(squeezed).toEqual({ rows: 1, inside: true });

  // Given the room back, the words return.
  await jot.evaluate((section) => {
    section.closest('aside')!.style.removeProperty('width');
  });
  await expect(labels.last()).toBeVisible();
});

test('sits under the file list on the footer, and grows upward as lines are added', async ({
  page,
}) => {
  await openInitializedSite(page);
  const jot = quickJot(page);
  await expect(jot).toBeVisible();
  const edges = () =>
    jot.evaluate((section) => {
      const box = section.getBoundingClientRect();
      const sidebar = section.closest('.db-shell-sidebar')!;
      const files = sidebar.querySelector('.db-file-explorer')!.getBoundingClientRect();
      const footer = sidebar.querySelector('.db-shell-sidebar-footer')!.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, filesBottom: files.bottom, footerTop: footer.top };
    });

  const before = await edges();
  expect(before.top).toBeGreaterThanOrEqual(before.filesBottom - 0.5);
  expect(Math.abs(before.bottom - before.footerTop)).toBeLessThanOrEqual(0.5);

  await jot.getByLabel('Jot something down').fill('One\nTwo\nThree\nFour\nFive');
  await expect.poll(async () => (await edges()).top).toBeLessThan(before.top - 20);
  const after = await edges();
  // The bottom edge stays on the footer; the file list gives way above.
  expect(Math.abs(after.bottom - before.bottom)).toBeLessThanOrEqual(0.5);
  expect(after.top).toBeGreaterThanOrEqual(after.filesBottom - 0.5);
});

test('an empty jot is faded until pointed at, focused, or given something', async ({ page }) => {
  await openInitializedSite(page);
  const jot = quickJot(page);
  await expect(jot).toBeVisible();
  const field = jot.getByLabel('Jot something down');
  // The contents fade, not the section, so its top rule stays the pane's.
  const opacity = () =>
    jot.evaluate((section) => ({
      section: Number(getComputedStyle(section).opacity),
      field: Number(getComputedStyle(section.querySelector('.db-quick-jot-field')!).opacity),
      toolbar: Number(getComputedStyle(section.querySelector('.db-quick-jot-toolbar')!).opacity),
    }));

  await page.mouse.move(0, 0);
  await expect.poll(opacity).toEqual({ section: 1, field: 0.75, toolbar: 0.75 });

  await jot.hover();
  await expect.poll(opacity).toEqual({ section: 1, field: 1, toolbar: 1 });

  // Focus keeps it awake after the pointer leaves, and so does what was typed.
  await field.focus();
  await page.mouse.move(0, 0);
  await expect.poll(opacity).toEqual({ section: 1, field: 1, toolbar: 1 });
  await field.fill('Groceries');
  await field.blur();
  await expect.poll(opacity).toEqual({ section: 1, field: 1, toolbar: 1 });

  await field.fill('');
  await field.blur();
  await expect.poll(opacity).toEqual({ section: 1, field: 0.75, toolbar: 0.75 });
});

test('Settings hides Quick Jot and brings it back', async ({ page }) => {
  await openInitializedSite(page);
  await expect(quickJot(page)).toBeVisible();

  let dialog = await openSettings(page);
  await dialog.getByLabel('Show Quick Jot').uncheck();
  await expect(quickJot(page)).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close' }).click();

  // The choice is remembered on this device.
  await page.reload();
  await expect(page.locator('.db-explorer-toolbar')).toBeVisible({ timeout: 60_000 });
  await expect(quickJot(page)).toHaveCount(0);

  dialog = await openSettings(page);
  await dialog.getByLabel('Show Quick Jot').check();
  await expect(quickJot(page)).toBeVisible();
});
