import { expect, test } from './helpers/test.js';
import { openInitializedSite } from './helpers/site.js';

/**
 * Media edits end to end on the site: a recording uploaded into a document is
 * cleaned up from its node view, the recipe lands in the markdown, the
 * processed audio renders in the background (worker + RNNoise + Opus), and
 * undo takes the recipe back out.
 */

/** A 3 s, 48 kHz, 16-bit mono WAV: tone bursts over light hiss. */
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
  let seed = 7;
  for (let i = 0; i < samples; i += 1) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    const hiss = ((seed / 4294967296) * 2 - 1) * 0.01;
    const burst = Math.floor(i / (sampleRate * 0.4)) % 2 === 0 ? 0.3 : 0;
    const value = burst * Math.sin((2 * Math.PI * 220 * i) / sampleRate) + hiss;
    view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(value * 32767))), true);
  }
  return Array.from(new Uint8Array(buffer));
}

test('cleans up a clip’s audio non-destructively and renders it in the background', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openInitializedSite(page);

  await page.getByRole('button', { name: 'New File' }).click();
  await page.locator('.db-new-item-input').fill('media-take');
  await page.locator('.db-new-item-add').click();
  const row = page.locator('.db-tree-row', { hasText: 'media-take' });
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();

  // Upload the recording through the Files panel: it is stored in
  // media-take_files/ and inserted at the cursor as a playable <audio>
  // element (the form a recorder inserts).
  const content = page.locator('.squisq-editor-content [contenteditable="true"]').first();
  await expect(content).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Toggle Files panel' }).click();
  await page
    .locator('.squisq-media-bin input[type="file"]')
    .setInputFiles({ name: 'take.wav', mimeType: 'audio/wav', buffer: Buffer.from(wavBytes()) });
  await expect(page.locator('.squisq-media-bin').getByText('take.wav').first()).toBeVisible({
    timeout: 20_000,
  });

  const editButton = page.getByRole('button', { name: 'Edit audio' });
  await expect(editButton).toBeVisible({ timeout: 30_000 });
  // ProseMirror merges edits less than 500 ms apart into one undo step; a
  // person cannot open the panel and apply that fast, so keep the insert and
  // the recipe edit in separate steps the way real use does.
  await page.waitForTimeout(600);
  await expect(editButton).toBeVisible({ timeout: 30_000 });
  await expect(editButton).toHaveAttribute('data-edited', 'false');

  await editButton.click();
  const modal = page.getByTestId('media-edit-modal');
  await expect(modal).toBeVisible();
  await modal.getByRole('button', { name: 'Clean up voice' }).click();
  await modal.getByRole('button', { name: 'Apply' }).click();
  await expect(modal).toBeHidden();
  await expect(editButton).toHaveAttribute('data-edited', 'true', { timeout: 10_000 });

  // The render runs in the background; reopening shows its status.
  await editButton.click();
  await expect(modal.getByText('Processed audio is in use.')).toBeVisible({ timeout: 120_000 });
  await modal.getByRole('button', { name: 'Cancel' }).click();

  // Undo removes the recipe; the source file was never touched.
  await page.locator('.squisq-editor-content').first().click();
  await page.keyboard.press('ControlOrMeta+Z');
  await expect(editButton).toHaveAttribute('data-edited', 'false', { timeout: 10_000 });
});
