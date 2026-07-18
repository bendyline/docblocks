import { expect, test } from '@playwright/test';

test.describe('marketing pages on a narrow viewport', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('keeps the format header compact and signposts the scrollable table', async ({
    page,
  }, testInfo) => {
    await page.goto('/formats/');

    const header = page.locator('.site-header');
    await expect(header).toBeVisible();
    expect((await header.boundingBox())?.height).toBeLessThan(140);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );

    await expect(page.locator('.table-scroll-hint')).toBeVisible();
    const tableRegion = page.getByRole('region', { name: 'Supported import and export formats' });
    await expect(tableRegion).toBeVisible();
    const dimensions = await tableRegion.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.clientWidth);

    await tableRegion.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    expect(
      await tableRegion.evaluate((element) => {
        const lastHeader = element.querySelector('th:last-child');
        if (!lastHeader) return false;
        const regionBounds = element.getBoundingClientRect();
        const headerBounds = lastHeader.getBoundingClientRect();
        return (
          headerBounds.left >= regionBounds.left && headerBounds.right <= regionBounds.right + 1
        );
      }),
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('formats-mobile.png'), fullPage: true });
  });

  test('uses the same compact header on documentation pages', async ({ page }, testInfo) => {
    await page.goto('/docs/');

    const header = page.locator('.site-header');
    await expect(header).toBeVisible();
    expect((await header.boundingBox())?.height).toBeLessThan(140);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await page.screenshot({ path: testInfo.outputPath('docs-mobile.png'), fullPage: true });
  });
});
