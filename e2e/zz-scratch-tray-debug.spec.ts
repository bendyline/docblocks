// TEMPORARY diagnostic spec — delete after use.
import { expect, test } from './helpers/test.js';
import { openInitializedSite } from './helpers/site.js';
import { openAttachments } from './helpers/toolbar.js';

function wavBytes(): number[] {
  const sampleRate = 48_000;
  const samples = sampleRate * 3;
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i += 1) {
    const value = 0.3 * Math.sin((2 * Math.PI * 220 * i) / sampleRate);
    view.setInt16(44 + i * 2, Math.round(value * 32767), true);
  }
  return Array.from(new Uint8Array(buffer));
}

test('diagnose tray collapse after Apply', async ({ page }) => {
  test.setTimeout(180_000);
  await openInitializedSite(page);
  await page.getByRole('button', { name: 'New File' }).click();
  await page.locator('.db-new-item-input').fill('media-take');
  await page.locator('.db-new-item-add').click();
  const content = page.getByRole('textbox', { name: 'Edit media-take.md', exact: true });
  await expect(content).toBeVisible({ timeout: 30_000 });

  await openAttachments(page);
  await page
    .locator('.squisq-media-bin input[type="file"]')
    .setInputFiles({ name: 'take.wav', mimeType: 'audio/wav', buffer: Buffer.from(wavBytes()) });
  const tray = page.getByRole('region', { name: 'Document tray', exact: true });
  const pill = tray.getByRole('button', { name: 'Audio: take.wav', exact: true });
  await expect(pill).toHaveAttribute('aria-expanded', 'false', { timeout: 30_000 });
  await pill.click();
  await expect(pill).toHaveAttribute('aria-expanded', 'true');
  const editButton = tray.getByRole('button', { name: 'Edit audio' });
  await page.waitForTimeout(600);
  await expect(editButton).toHaveAttribute('data-edited', 'false');

  const html = async (label: string) => {
    const pm = await page.locator('.ProseMirror').first().evaluate((e) => e.innerHTML.slice(0, 1500));
    console.log(`--- ${label} PM html:\n${pm}`);
  };
  await html('before apply');

  await page.evaluate(`(() => {
    document.querySelector('.ProseMirror').setAttribute('data-mark', 'pm');
    document.querySelector('.squisq-document-tray').setAttribute('data-mark', 'tray');
    document.querySelector('.squisq-document-tray-item').setAttribute('data-mark', 'item');
    window.__log = [];
    const t0 = performance.now();
    const snap = (why) => {
      const pm = document.querySelector('.ProseMirror');
      const tray = document.querySelector('.squisq-document-tray');
      const item = document.querySelector('.squisq-document-tray-item');
      const pillEl = item && item.querySelector('[aria-expanded]');
      window.__log.push([Math.round(performance.now() - t0), why,
        pm ? (pm.getAttribute('data-mark') || 'NEW-pm') : 'no-pm',
        tray ? (tray.getAttribute('data-mark') || 'NEW-tray') : 'no-tray',
        item ? (item.getAttribute('data-mark') || 'NEW-item') : 'no-item',
        pillEl ? pillEl.getAttribute('aria-expanded') : '-',
        document.title].join(' | '));
    };
    new MutationObserver(() => snap('mut')).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-expanded'] });
    window.__snap = snap;
  })()`);

  await editButton.click();
  const modal = page.getByTestId('media-edit-modal');
  await expect(modal).toBeVisible();
  await modal.getByRole('button', { name: 'Clean up voice' }).click();
  await page.evaluate(`window.__snap('before-apply-click')`);
  await modal.getByRole('button', { name: 'Apply' }).click();
  await expect(modal).toBeHidden();
  await page.waitForTimeout(3000);
  const log = (await page.evaluate(`window.__log`)) as string[];
  // Collapse runs of identical states.
  let prev = '';
  for (const line of log) {
    const state = line.split(' | ').slice(2).join(' | ');
    if (state !== prev) console.log(line);
    prev = state;
  }
  await html('after apply');
});
