import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { expect, test } from './helpers/test.js';
import { openInitializedSite } from './helpers/site.js';
import { openAttachments } from './helpers/toolbar.js';

/**
 * Edited clips outside the editor, end to end on the site: a recording is cut
 * on the Cuts timeline, and the cut is then BAKED into an ordinary file for
 * the two places nothing can apply it as the clip plays — a copy saved from
 * the Edit dialog, and a plain Web page export.
 */

const TAKE_SECONDS = 4;

/** A 4 s, 48 kHz, 16-bit mono WAV: a steady tone, so its length is all that matters. */
function wavBytes(): number[] {
  const sampleRate = 48_000;
  const samples = sampleRate * TAKE_SECONDS;
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

test('bakes a cut clip for a saved copy and for a plain Web page export', async ({ page }) => {
  test.setTimeout(240_000);
  await openInitializedSite(page);

  await page.getByRole('button', { name: 'New File' }).click();
  await page.locator('.db-new-item-input').fill('cut-take');
  await page.locator('.db-new-item-add').click();
  const content = page.getByRole('textbox', { name: 'Edit cut-take.md', exact: true });
  await expect(content).toBeVisible({ timeout: 30_000 });

  await openAttachments(page);
  await page
    .locator('.squisq-media-bin input[type="file"]')
    .setInputFiles({ name: 'take.wav', mimeType: 'audio/wav', buffer: Buffer.from(wavBytes()) });
  await expect(page.locator('.squisq-media-bin').getByText('take.wav').first()).toBeVisible({
    timeout: 20_000,
  });

  const tray = page.getByRole('region', { name: 'Document tray', exact: true });
  const pill = tray.getByRole('button', { name: 'Audio: take.wav', exact: true });
  await expect(pill).toHaveAttribute('aria-expanded', 'false', { timeout: 30_000 });
  await pill.click();
  const editButton = tray.getByRole('button', { name: 'Edit audio' });
  await expect(editButton).toBeVisible({ timeout: 30_000 });
  // Keep the insert and the recipe edit in separate undo steps, as real use does.
  await page.waitForTimeout(600);
  await editButton.click();

  // Cut the second second of the take on the Cuts timeline, from the keyboard.
  const modal = page.getByTestId('media-edit-modal');
  await modal.getByRole('tab', { name: 'Cuts', exact: true }).click();
  const timeline = modal.getByRole('group', { name: 'Clip timeline' });
  await expect(timeline).toBeVisible({ timeout: 60_000 });
  await timeline.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('i');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('o');
  await page.keyboard.press('x');
  await expect(
    modal.getByText('1 cut removes 1.0 s: the clip plays for 0:03 instead of 0:04.'),
  ).toBeVisible();

  // Save edited copy: the cut is not applied yet, and the copy has it anyway.
  const [copy] = await Promise.all([
    page.waitForEvent('download', { timeout: 120_000 }),
    modal.getByRole('button', { name: 'Save edited copy…', exact: true }).click(),
  ]);
  // M4A where the browser encodes AAC (Chrome, Edge); Opus in WebM where it does not.
  expect(copy.suggestedFilename()).toMatch(/^take-edited\.(m4a|webm|wav)$/);
  await expect(modal.getByText(`Saved ${copy.suggestedFilename()}.`)).toBeVisible();

  await modal.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(modal).toBeHidden();
  // The cut is on the clip now; the tray redraws its pill for the edited tag.
  await expect(pill).toBeVisible({ timeout: 10_000 });

  // The clip's own player in the document plays it as cut: started inside
  // the removed second, it jumps to the far side instead of playing it.
  if ((await pill.getAttribute('aria-expanded')) !== 'true') await pill.click();
  const player = tray.locator('audio');
  await expect(player).toBeVisible({ timeout: 10_000 });
  const resumedAt = await player.evaluate(async (element) => {
    const audio = element as HTMLAudioElement;
    audio.muted = true;
    audio.currentTime = 1.3;
    await audio.play();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const at = audio.currentTime;
    audio.pause();
    return at;
  });
  expect(resumedAt).toBeGreaterThanOrEqual(2);
  expect(resumedAt).toBeLessThan(3.2);

  // A plain Web page has no script to skip the cut, so the export bakes it.
  await page.getByRole('button', { name: 'Export and share', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Export document...', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export Document' });
  await dialog.getByRole('radio', { name: 'HTML', exact: true }).click();
  await dialog.getByRole('radio', { name: 'Plain', exact: true }).click();
  await dialog.getByRole('radio', { name: 'ZIP archive', exact: true }).click();
  const [exported] = await Promise.all([
    page.waitForEvent('download', { timeout: 120_000 }),
    dialog.getByRole('button', { name: 'Save ZIP to Downloads', exact: true }).click(),
  ]);
  expect(await exported.failure()).toBeNull();

  const zip = await JSZip.loadAsync(await readFile(await exported.path()));
  const files = Object.keys(zip.files).filter((name) => !name.endsWith('/'));
  const baked = files.find((name) => /^cut-take_files\/take-edited\.(m4a|webm|wav)$/.test(name));
  expect(baked, `the baked clip in ${files.join(', ')}`).toBeDefined();
  // Under a visible name: the store folder is hidden, and many Web hosts will not serve it.
  expect(files.filter((name) => name.includes('.mediaEdits'))).toEqual([]);
  // The page plays the baked file; the original is neither referenced nor shipped.
  const html = await zip.file('index.html')!.async('text');
  expect(html).toContain(`src="${baked}"`);
  expect(html).not.toContain('take.wav');
  expect(files).not.toContain('cut-take_files/take.wav');

  // The baked file is one second shorter than the take.
  const bytes = await zip.file(baked!)!.async('base64');
  const duration = await page.evaluate(async (base64) => {
    const binary = atob(base64);
    const data = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) data[i] = binary.charCodeAt(i);
    const context = new AudioContext();
    try {
      return (await context.decodeAudioData(data.buffer)).duration;
    } finally {
      await context.close();
    }
  }, bytes);
  expect(duration).toBeGreaterThan(TAKE_SECONDS - 1 - 0.15);
  expect(duration).toBeLessThan(TAKE_SECONDS - 1 + 0.15);
});
