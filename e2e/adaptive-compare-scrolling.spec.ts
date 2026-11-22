import type { Locator, Page } from '@playwright/test';
import { expect, test } from './helpers/test.js';
import { welcomeDocumentContent } from '../packages/react/src/DocBlocksShell/welcome-document.js';

/**
 * The differences between two versions, on a touch screen. Monaco scrolls its
 * own view by imitating touch scrolling, which stops dead after a moment and
 * holds off the device's own. Here the box around the diff scrolls it
 * instead. Runs on the touch-emulating device projects in playwright.config.ts.
 */

/** Open the welcome document, which every fresh context starts with. */
async function openWelcomeDocument(page: Page): Promise<void> {
  await page.goto('/');
  const tour = page.getByRole('button', { name: 'Tour the welcome document' });
  const startWriting = page.locator('.db-welcome-gateway-cta');
  await expect(tour.or(startWriting).first()).toBeVisible({ timeout: 30_000 });
  await ((await tour.count()) > 0 ? tour : startWriting).click();
  await expect(page.locator('.squisq-toolbar')).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('docblocks:lastState')))
    .not.toBeNull();
  // Let proofing finish loading its engine: reloading in the middle cancels
  // the download, and WebKit reports each cancelled fetch as an error.
  await expect(page.locator('.squisq-proof-status')).toHaveText(/^(✓ Proofing|\d+ issues?)$/u, {
    timeout: 60_000,
  });
}

/**
 * Leave a recovered draft of the open document, as a session that ended
 * before saving would, so the next load asks which version to keep.
 */
async function leaveRecoveredDraft(page: Page, draft: string): Promise<void> {
  await page.evaluate((draft) => {
    const state = JSON.parse(localStorage.getItem('docblocks:lastState')!);
    const targetKey = `${state.workspaceId}:${state.filePath.replace(/^\/+/, '')}`;
    const now = Date.now();
    localStorage.setItem(
      'docblocks:document-recovery:v1',
      JSON.stringify({
        schemaVersion: 1,
        records: [
          {
            targetKey,
            generation: 2,
            revision: 4,
            content: draft,
            persistedContent: '# Earlier baseline',
            createdAt: now - 3_600_000,
            updatedAt: now - 3_600_000,
          },
        ],
      }),
    );
  }, draft);
}

/** A finger drawn up the screen, through Chromium's own input pipeline. */
async function swipeUp(page: Page, target: Locator, distance: number): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error('nothing to swipe');
  const x = box.x + box.width / 2;
  const from = box.y + box.height * 0.75;
  const cdp = await page.context().newCDPSession(page);
  const STEPS = 12;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y: from, id: 1 }],
  });
  for (let step = 1; step <= STEPS; step++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: from - (distance * step) / STEPS, id: 1 }],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

test.describe('comparing versions on a touch screen', () => {
  test.skip(({ isMobile }) => isMobile !== true, 'touch-emulating projects only');

  test('scrolls the differences as the device scrolls', async ({ page, browserName }) => {
    await openWelcomeDocument(page);
    const saved = welcomeDocumentContent({ browserStorage: true, desktopApp: false });
    const draft = saved
      .replace('# Welcome to DocBlocks', '# Welcome back to DocBlocks')
      .replace('for everything else.', 'for everything else, whenever you like.');
    expect(draft).not.toBe(saved);
    await leaveRecoveredDraft(page, draft);
    await page.reload();

    const resolve = page.getByRole('button', { name: 'Resolve', exact: true });
    await expect(resolve).toBeVisible({ timeout: 30_000 });
    await resolve.tap();
    const dialog = page.getByRole('dialog', { name: 'Compare document versions' });
    await expect(dialog).toBeVisible();
    // A phone opens on the differences; a tablet shows every pane at once.
    const changesTab = dialog.getByRole('tab', { name: 'Changes' });
    if (await changesTab.isVisible()) await changesTab.tap();
    const differences = dialog.getByRole('region', { name: 'Differences' });
    await expect(differences).toBeVisible();
    // The whole document, so there is a long way to scroll.
    await dialog.getByRole('combobox', { name: 'View' }).selectOption('inline');

    // The box around the diff scrolls it, not Monaco.
    const box = differences.locator('.db-git-diff-host');
    await expect(box).toHaveClass(/\bdb-git-diff-host--scrolls\b/);
    const editor = differences.locator('.db-git-diff-editor');
    const editorHeight = () => editor.evaluate((element) => element.getBoundingClientRect().height);
    await expect(differences).toContainText('There is no account to create.', { timeout: 20_000 });
    await expect.poll(editorHeight).toBeGreaterThan(600);

    // The editor is the whole diff's height; the box stays its own size.
    const sizes = await box.evaluate((element) => ({
      client: element.clientHeight,
      scroll: element.scrollHeight,
    }));
    expect(sizes.client).toBeGreaterThan(100);
    expect(sizes.scroll).toBeGreaterThan(sizes.client + 200);
    expect(Math.round(await editorHeight())).toBe(sizes.scroll);

    // WebKit takes no synthetic touch drags; Chromium does, through the same
    // path a finger takes. Monaco, given the touch, would cancel the scroll.
    if (browserName === 'chromium') {
      await swipeUp(page, box, 240);
      await expect.poll(() => box.evaluate((element) => element.scrollTop)).toBeGreaterThan(120);
    }
  });
});
