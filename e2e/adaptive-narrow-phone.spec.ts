import type { Locator, Page } from '@playwright/test';
import { expect, test } from './helpers/test.js';
import { chooseDocumentAction } from './helpers/toolbar.js';

/**
 * Chrome that ran off a 360px phone, found by the affordance crawl's overflow
 * probe (AFFORDANCE_PHONE_WIDTH=360): the workspace menu in the file drawer,
 * the emoji picker, the version history popover, the teleprompter's controls
 * and the video player's timeline.
 */

const NARROW = { width: 360, height: 780 };

async function openWelcomeDocument(page: Page): Promise<void> {
  await page.setViewportSize(NARROW);
  await page.goto('/');
  const shell = page.locator('.db-shell');
  await expect(shell).toBeVisible();
  const tour = page.getByRole('button', { name: 'Tour the welcome document' });
  const startWriting = page.locator('.db-welcome-gateway-cta');
  await expect(tour.or(startWriting).first()).toBeVisible({ timeout: 30_000 });
  await ((await tour.count()) > 0 ? tour : startWriting).click();
  await expect(page.locator('.squisq-toolbar')).toBeVisible({ timeout: 30_000 });
  await expect(shell).toHaveAttribute('data-db-drawer', 'closed');
}

/**
 * Descendants of `container` (and the container) reaching outside `bounds` or the screen.
 *
 * The frame and its descendants are measured in one pass. A popover can still
 * be settling as it opens (Version history widens when its list finishes
 * loading), and a frame read a moment before its contents made every
 * full-width child look like it spilled.
 */
async function spillsOutside(container: Locator, bounds?: Locator): Promise<string[]> {
  const boundsHandle = bounds ? await bounds.elementHandle() : null;
  return container.evaluate((root, boundsElement) => {
    const edges = (boundsElement ?? root).getBoundingClientRect();
    if (edges.width === 0 && edges.height === 0) throw new Error('container not laid out');
    const viewport = document.documentElement.clientWidth;
    const left = Math.max(edges.left, 0);
    const right = Math.min(edges.right, viewport);
    return [root, ...root.querySelectorAll<HTMLElement>('*')]
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return (
          rect.width > 0 && rect.height > 0 && (rect.left < left - 1 || rect.right > right + 1)
        );
      })
      .map((node) => `${node.tagName.toLowerCase()}.${String(node.className).split(' ')[0]}`);
  }, boundsHandle);
}

test.describe('Chrome on a 360px phone', () => {
  test.skip(
    ({ isMobile, viewport }) => isMobile !== true || (viewport?.width ?? 0) > 600,
    'phone projects only',
  );

  test('keeps the workspace menu inside the file drawer', async ({ page }) => {
    await openWelcomeDocument(page);
    await page.getByRole('button', { name: 'Show file list' }).click();
    await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
    const menu = page.locator('.db-ws-settings-dropdown');
    await expect(menu).toBeVisible();
    expect(await spillsOutside(menu, page.locator('.db-shell-sidebar'))).toEqual([]);
  });

  test('fits the emoji picker on screen without sideways scrolling', async ({ page }) => {
    await openWelcomeDocument(page);
    await page.getByRole('button', { name: 'Insert', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Emoji', exact: true }).click();
    const grid = page.locator('[data-picker-kind]').first().locator('..');
    await expect(grid).toBeVisible();
    expect(await grid.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(
      1,
    );
    expect(await spillsOutside(grid.locator('..'))).toEqual([]);
  });

  test('keeps version history on screen', async ({ page }) => {
    await openWelcomeDocument(page);
    const popover = page.getByRole('dialog', { name: 'Version history' });
    await chooseDocumentAction(page, 'Version history', popover);
    expect(await spillsOutside(popover)).toEqual([]);
  });

  test('wraps the teleprompter controls inside the player', async ({ page }) => {
    await openWelcomeDocument(page);
    await page.getByRole('button', { name: 'Choose Use mode', exact: true }).click();
    await page.getByRole('menuitemradio', { name: /^Narrate/ }).click();
    const controls = page.locator('.squisq-teleprompter-controls');
    await expect(controls).toBeVisible({ timeout: 30_000 });
    expect(await spillsOutside(controls)).toEqual([]);
  });

  test('gives the video timeline a usable width', async ({ page }) => {
    await openWelcomeDocument(page);
    await page.getByRole('button', { name: 'Choose Use mode', exact: true }).click();
    await page.getByRole('menuitemradio', { name: /^Video/ }).click();
    const timeline = page.getByRole('group', { name: 'Playback timeline' });
    await expect(timeline).toBeVisible({ timeout: 30_000 });
    expect((await timeline.boundingBox())!.width).toBeGreaterThanOrEqual(120);
    expect(await spillsOutside(page.locator('.doc-player__controls'))).toEqual([]);
  });
});
