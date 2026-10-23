import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures.js';

test('speech license links remain identifiable in light and dark Settings', async ({
  launchApp,
}, info) => {
  const { window } = await launchApp();
  await window.locator('.db-app-menu-btn').click();
  await window.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  const dialog = window.getByRole('dialog', { name: 'Settings', exact: true });
  const links = dialog.locator('.db-settings-speech-model .db-settings-hint a');
  await expect(links).toHaveCount(4);
  for (const theme of ['Light', 'Dark']) {
    await dialog.getByRole('radio', { name: theme, exact: true }).check();
    for (const link of await links.all()) {
      expect(await link.evaluate((node) => getComputedStyle(node).textDecorationLine)).toContain(
        'underline',
      );
      await link.focus();
      await expect(link).toBeFocused();
      expect(await link.evaluate((node) => getComputedStyle(node).textDecorationLine)).toContain(
        'underline',
      );
      await link.hover();
      expect(await link.evaluate((node) => getComputedStyle(node).textDecorationLine)).toContain(
        'underline',
      );
    }
    const { violations } = await new AxeBuilder({ page: window })
      .setLegacyMode()
      .include('.db-settings-speech-model')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(violations).toEqual([]);
    await window.screenshot({ path: info.outputPath(`speech-links-${theme.toLowerCase()}.png`) });
  }
});
