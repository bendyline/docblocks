import { expect, test } from './helpers/test.js';
import { openInitializedSite } from './helpers/site.js';

test.beforeEach(async ({ page }) => {
  await openInitializedSite(page);
});

test('Share receives focus, contains Tab, and restores the export trigger', async ({ page }) => {
  const trigger = page.getByRole('button', { name: 'Export and share', exact: true });
  await trigger.press('ArrowDown');
  await page.getByRole('menuitem', { name: 'Share link with content embedded...' }).press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Share document' });
  const close = dialog.getByRole('button', { name: 'Close', exact: true }).first();
  await expect(close).toBeFocused();
  const copy = dialog.getByRole('button', { name: 'Copy link', exact: true });
  await expect(copy).toBeEnabled();
  await copy.focus();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(copy).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test('Export radio groups support arrows, wrapping, and a single tab stop', async ({ page }) => {
  const trigger = page.getByRole('button', { name: 'Export and share', exact: true });
  await trigger.press('ArrowDown');
  await page.getByRole('menuitem', { name: 'Export document...', exact: true }).press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Export Document' });
  const formats = dialog.getByRole('radiogroup', { name: 'Format', exact: true });
  const pdf = formats.getByRole('radio', { name: 'PDF', exact: true });
  const word = formats.getByRole('radio', { name: 'Word', exact: true });
  await pdf.press('ArrowRight');
  await expect(word).toBeChecked();
  await expect(word).toBeFocused();
  await expect(formats.locator('[tabindex="0"]')).toHaveCount(1);
  await page.keyboard.press('ArrowUp');
  await expect(pdf).toBeChecked();
  await page.keyboard.press('ArrowLeft');
  await expect(formats.getByRole('radio', { name: 'Markdown', exact: true })).toBeChecked();
  await page.keyboard.press('ArrowDown');
  await expect(pdf).toBeChecked();
  await page.keyboard.press('Tab');
  await expect(dialog.getByLabel('Theme', { exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
});

for (const scenario of [
  { trigger: 'DocBlocks', item: 'Settings', dialog: 'Settings' },
  { trigger: 'DocBlocks', item: 'About', dialog: 'About DocBlocks' },
  { trigger: 'Workspace settings', item: 'Workspace settings…', dialog: 'Workspace settings' },
]) {
  test(`${scenario.dialog} returns keyboard focus to its menu trigger`, async ({ page }) => {
    const trigger = page.getByRole('button', { name: scenario.trigger, exact: true });
    await trigger.press('ArrowDown');
    await page.getByRole('menuitem', { name: scenario.item, exact: true }).press('Enter');
    const dialog = page.getByRole('dialog', { name: scenario.dialog, exact: true });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
  });
}

test('ArrowDown enters an app menu that was opened with the pointer', async ({ page }) => {
  const trigger = page.getByRole('button', { name: 'DocBlocks', exact: true });
  await trigger.click();
  await trigger.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Settings', exact: true })).toBeFocused();
});
