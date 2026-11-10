import type { Locator, Page } from '@playwright/test';
import { installFakeSpeechHost, scaleText } from './helpers/fake-speech-host.js';
import { expect, test } from './helpers/test.js';

/**
 * Settings sections on the touch-emulating device projects: phones and
 * portrait tablets pick a section from a dropdown, while a landscape tablet
 * keeps the tab rail a desktop window gets.
 */

async function openSettings(page: Page) {
  await page.goto('/');
  const shell = page.locator('.db-shell');
  await expect(shell).toBeVisible();
  // Which first-run gateway appears depends on the layout; wait for either.
  const tour = page.getByRole('button', { name: 'Tour the welcome document' });
  const startWriting = page.locator('.db-welcome-gateway-cta');
  await expect(tour.or(startWriting).first()).toBeVisible({ timeout: 30_000 });
  await ((await tour.count()) > 0 ? tour : startWriting).click();
  await expect(page.locator('.squisq-toolbar')).toBeVisible({ timeout: 30_000 });
  // In single-pane the app menu lives in the drawer.
  if ((await shell.getAttribute('data-db-layout')) === 'single-pane') {
    await expect(shell).toHaveAttribute('data-db-drawer', 'closed');
    await page.getByRole('button', { name: 'Show file list' }).click();
    await expect(shell).toHaveAttribute('data-db-drawer', 'open');
  }
  await page.locator('.db-app-menu-btn').click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('Settings sections on touch devices', () => {
  test.skip(({ isMobile }) => isMobile !== true, 'touch-emulating projects only');

  test('use a dropdown on phones and portrait tablets and tabs in landscape', async ({
    page,
  }, testInfo) => {
    const dialog = await openSettings(page);
    const picker = dialog.getByRole('combobox', { name: 'Settings section' });

    if (testInfo.project.name.includes('landscape')) {
      await expect(dialog.getByRole('tablist', { name: 'Settings sections' })).toBeVisible();
      await expect(picker).toHaveCount(0);
      await dialog.getByRole('tab', { name: 'Device integration', exact: true }).click();
    } else {
      await expect(dialog.getByRole('tablist')).toHaveCount(0);
      await expect(picker).toHaveValue('appearance');
      await picker.selectOption({ label: 'Device integration' });
    }
    await expect(dialog.getByRole('group', { name: 'Version history' })).toBeVisible();
    await expect(dialog.getByRole('group', { name: 'Theme' })).toBeHidden();

    const layout = await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        insideViewport:
          rect.left >= 0 &&
          rect.top >= 0 &&
          rect.right <= window.innerWidth &&
          rect.bottom <= window.innerHeight,
        scrollsSideways: element.scrollWidth > element.clientWidth,
      };
    });
    expect(layout.insideViewport).toBe(true);
    expect(layout.scrollsSideways).toBe(false);
  });
});

/** What in the open section reaches past the panel's padded content edge. */
async function sectionOverflow(dialog: Locator): Promise<string[]> {
  return dialog.evaluate((element) => {
    const panel = element.querySelector<HTMLElement>('.db-settings-panel:not([hidden])');
    if (!panel) return ['no open section'];
    const style = getComputedStyle(panel);
    const edge = panel.getBoundingClientRect().right - parseFloat(style.paddingRight);
    const found = [...panel.querySelectorAll<HTMLElement>('*')]
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.right > edge + 0.5;
      })
      .map((node) => `${node.tagName.toLowerCase()}.${String(node.className).split(' ')[0]}`);
    if (panel.scrollWidth > panel.clientWidth) found.unshift('panel scrolls sideways');
    return found;
  });
}

test.describe('Settings sections on a narrow phone', () => {
  test.skip(({ isMobile }) => isMobile !== true, 'touch-emulating projects only');

  // A 360px phone with Android's larger system text pushed the narration
  // model's download row, and the whole section with it, off the dialog.
  test('fit every section, downloads included, at a large text size', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name.startsWith('ipad'), 'phone projects only');
    await installFakeSpeechHost(page);
    await page.setViewportSize({ width: 360, height: 760 });
    const dialog = await openSettings(page);
    const picker = dialog.getByRole('combobox', { name: 'Settings section' });
    const sections = await picker.locator('option').allTextContents();
    expect(sections).toEqual(expect.arrayContaining(['Dictation', 'Narration']));

    for (const scale of [1, 1.3]) {
      for (const section of sections) {
        await picker.selectOption({ label: section });
        // Scales whatever the section newly rendered; each element only once.
        if (scale !== 1) await scaleText(page, scale);
        expect(await sectionOverflow(dialog), `${section} at ${scale}x text`).toEqual([]);
      }
    }

    await picker.selectOption({ label: 'Narration' });
    await dialog
      .getByRole('button', { name: /^Download/ })
      .first()
      .click();
    await expect(dialog.locator('progress')).toBeVisible();
    await scaleText(page, 1.3);
    expect(await sectionOverflow(dialog), 'Narration downloading').toEqual([]);
  });
});
