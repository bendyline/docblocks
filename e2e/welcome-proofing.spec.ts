import { expect, test } from './helpers/test.js';
import { openProofedWelcome } from './helpers/proofing.js';

for (const view of ['Write', 'Source'] as const) {
  test(`welcome proofing is clean in ${view} and still finds real errors`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    await page.addInitScript((sourceView) => {
      localStorage.setItem('docblocks:themePreference', 'light');
      localStorage.setItem('docblocks:interfaceFont', 'fixed');
      // Also exercise the merge with personal words; built-ins must never
      // replace these or be written into the user's dictionary.
      if (sourceView) localStorage.setItem('docblocks:proofingDictionary', '["Quorblax"]');
    }, view === 'Source');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openProofedWelcome(page, view, view === 'Source' ? 'Quorblax' : undefined);
    expect(await page.evaluate(() => localStorage.getItem('docblocks:proofingDictionary'))).toBe(
      view === 'Source' ? '["Quorblax"]' : null,
    );
    // Capture only after a completed worker pass has removed the known errors.
    // Kept as an attachment for review, not compared against a baseline. Wait
    // for webfonts, then let layout react to the swap before capturing.
    await page.evaluate(() => document.fonts.ready.then(() => undefined)).catch(() => undefined);
    await page.waitForTimeout(150);
    const screenshot = testInfo.outputPath(`welcome-proofing-${view.toLowerCase()}.png`);
    await page.screenshot({ path: screenshot, animations: 'disabled', caret: 'hide' });
    await testInfo.attach(`welcome-proofing-${view.toLowerCase()}`, {
      path: screenshot,
      contentType: 'image/png',
    });
  });
}
