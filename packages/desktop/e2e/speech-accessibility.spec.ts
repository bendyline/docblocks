import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures.js';

// Whisper (MIT) and Kokoro (Apache-2.0) need no license named on their rows;
// model-license.test.ts covers which licenses stay visible and linked.
test('speech model rows stay accessible in light and dark Settings', async ({
  launchApp,
}, info) => {
  const { window } = await launchApp();
  await window.locator('.db-app-menu-btn').click();
  await window.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  const dialog = window.getByRole('dialog', { name: 'Settings', exact: true });
  for (const theme of ['Light', 'Dark']) {
    await dialog.getByRole('tab', { name: 'Appearance', exact: true }).click();
    await dialog.getByRole('radio', { name: theme, exact: true }).check();
    for (const section of ['Dictation', 'Narration']) {
      await dialog.getByRole('tab', { name: section, exact: true }).click();
      const rows = dialog
        .getByRole('tabpanel', { name: section })
        .locator('.db-settings-speech-model');
      await expect(rows.first()).toBeVisible();
      await expect(rows.locator('.db-settings-hint a')).toHaveCount(0);
      for (const text of await rows.allTextContents()) {
        expect(text).not.toMatch(/\bMIT\b|Apache/);
      }
      const { violations } = await new AxeBuilder({ page: window })
        .setLegacyMode()
        .include('.db-settings-panel:not([hidden]) .db-settings-speech-model')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(violations).toEqual([]);
      await window.screenshot({
        path: info.outputPath(`speech-rows-${section.toLowerCase()}-${theme.toLowerCase()}.png`),
      });
    }
  }
});
