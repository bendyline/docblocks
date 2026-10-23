import type { Locator, Page } from '@playwright/test';
import { expect, test } from './helpers/test.js';

async function expectMenuInsideViewport(menu: Locator): Promise<void> {
  await expect(menu).toBeVisible();
  // Page scrollWidth misses portaled fixed-position menus clipped by the
  // viewport. Check the rendered menu and its contents directly.
  await expect
    .poll(() =>
      menu.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.left >= 7 &&
          rect.right <= window.innerWidth - 7 &&
          element.scrollWidth <= element.clientWidth + 1
        );
      }),
    )
    .toBe(true);
}

async function openWelcomeInWrite(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Tour the welcome document', exact: true }).click();
  await page.getByRole('tab', { name: 'Write', exact: true }).click();
}

test.describe('Insert menu on narrow screens', () => {
  test.skip(({ isMobile }) => !isMobile, 'touch-emulating projects only');

  for (const width of [320, 390, 412]) {
    test(`keeps Insert and its submenus reachable at ${width}px`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name.startsWith('ipad'), 'phone projects only');
      await page.setViewportSize({ width, height: 844 });
      await openWelcomeInWrite(page);
      const trigger = page.getByRole('button', { name: 'Insert', exact: true });
      await trigger.click();
      const insert = page.locator('.squisq-insert-menu').first();
      await expectMenuInsideViewport(insert);

      const video = insert.getByRole('menuitem', {
        name: 'Online Video (YouTube, Vimeo, etc.)',
        exact: true,
      });
      // The longest label was the visible casualty of V01. Its text must fit
      // too, rather than merely hiding overflow on the menu container.
      await expect
        .poll(() =>
          video
            .locator('span')
            .last()
            .evaluate((label) => {
              const rect = label.getBoundingClientRect();
              const menu = label.closest('[role="menu"]')!.getBoundingClientRect();
              return Math.max(menu.left - rect.left, rect.right - menu.right);
            }),
        )
        .toBeLessThanOrEqual(0);
      const insertScreenshot = testInfo.outputPath(`insert-${width}.png`);
      await page.screenshot({ path: insertScreenshot });
      await testInfo.attach(`insert-${width}`, {
        path: insertScreenshot,
        contentType: 'image/png',
      });

      for (const [item, name] of [
        ['Chart', 'Chart type'],
        ['Complex Diagram (Mermaid)', 'Mermaid diagram type'],
        ['Insert Code Snippet', 'Code snippet language'],
      ]) {
        await insert.getByRole('menuitem', { name: item, exact: true }).click();
        const submenu = page.getByRole('menu', { name, exact: true });
        await expectMenuInsideViewport(submenu);
        const screenshot = testInfo.outputPath(`${name}-${width}.png`);
        await page.screenshot({ path: screenshot });
        await testInfo.attach(`${name}-${width}`, {
          path: screenshot,
          contentType: 'image/png',
        });
        await page.keyboard.press('Escape');
        await expect(submenu).toBeHidden();
        await expect(insert).toBeHidden();
        await trigger.click();
      }

      await video.click();
      await expect(insert).toBeHidden();
      await expect(page.getByRole('dialog')).toBeVisible();
    });
  }
});
