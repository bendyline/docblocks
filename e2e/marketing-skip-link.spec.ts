import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './helpers/test.js';

for (const colorScheme of ['light', 'dark'] as const) {
  test(`marketing skip links work with readable ${colorScheme} focus`, async ({ page }, info) => {
    await page.emulateMedia({ colorScheme });
    for (const route of [
      'web',
      'desktop',
      'vscode',
      'cli',
      'formats',
      'docs',
      'privacy',
      'terms',
      '404.html',
    ]) {
      await page.goto(route.endsWith('.html') ? `/${route}` : `/${route}/`);
      await page.keyboard.press('Tab');
      const skip = page.locator('.skip-link');
      await expect(skip).toBeFocused();
      await expect(skip).toBeInViewport();
      const { violations } = await new AxeBuilder({ page })
        .include('.skip-link')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(violations, route).toEqual([]);
      expect(await skip.evaluate((node) => getComputedStyle(node).outlineStyle)).toBe('solid');
      if (route === 'web')
        await page.screenshot({ path: info.outputPath(`skip-link-${colorScheme}.png`) });
      const target = await skip.getAttribute('href');
      await page.keyboard.press('Enter');
      await expect(page.locator(target!)).toBeFocused();
    }
  });
}
