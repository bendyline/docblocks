import type { Locator, Page } from '@playwright/test';
import { expect, test } from './helpers/test.js';
import { openAttachments, showWriteView } from './helpers/toolbar.js';

/**
 * The phone shell sets `position: static` on toolbar buttons so their menus
 * hang from the full-width toolbar. The Attachments toggle opens no menu, and
 * its file-count badge is absolutely positioned against it: made static, the
 * toggle handed the badge to the toolbar, and the count rendered on the
 * row's last button (Export), reading as an export count.
 */

/** A 1×1 transparent PNG. */
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function openWelcome(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Tour the welcome document', exact: true }).click();
  await showWriteView(page);
}

function boxOf(element: Locator) {
  return element.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  });
}

test('the attachment count stays on the Attachments toggle on phones', async ({ page }, info) => {
  test.skip(info.project.name.startsWith('ipad'), 'phone projects only');
  await openWelcome(page);

  await openAttachments(page);
  await page
    .locator('.squisq-media-bin input[type="file"]')
    .setInputFiles({ name: 'badge-probe.png', mimeType: 'image/png', buffer: PIXEL_PNG });
  await expect(page.locator('.squisq-media-bin').getByText('badge-probe.png').first()).toBeVisible({
    timeout: 20_000,
  });

  // Write's formatting row pushes the toggle into More actions on a phone;
  // Page keeps it inline, which is where the stray count was seen.
  await page.getByRole('button', { name: 'Choose Use mode' }).click();
  await page.getByRole('menuitemradio', { name: 'Page', exact: true }).click();

  const toggle = page.locator('.squisq-toolbar .squisq-toolbar-files-toggle');
  const badge = toggle.locator('.squisq-toolbar-files-badge');
  await expect(toggle).toBeVisible();
  await expect(badge).toBeVisible();

  const container = await boxOf(toggle);
  await expect
    .poll(async () => {
      const inner = await boxOf(badge);
      // The badge sits on the toggle's corner border; allow its 1.5px ring.
      const slack = 2;
      return (
        inner.left >= container.left - slack &&
        inner.top >= container.top - slack &&
        inner.right <= container.right + slack &&
        inner.bottom <= container.bottom + slack
      );
    })
    .toBe(true);
  await page.screenshot({ path: info.outputPath('attachments-badge.png') });
});
