import { readFile } from 'node:fs/promises';
import type { Locator } from '@playwright/test';
import { expect, test } from './helpers/test.js';
import { openInitializedSite } from './helpers/site.js';

test.use({
  viewport: { width: 1440, height: 1000 },
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
});

async function waitForRecordingSecond(dialog: Locator, minimum: number) {
  await expect
    .poll(async () => {
      const text = await dialog.getByText(/^● Recording \d+:\d+$/).innerText();
      const [, minutes, seconds] = text.match(/(\d+):(\d+)/)!;
      return Number(minutes) * 60 + Number(seconds);
    })
    .toBeGreaterThanOrEqual(minimum);
}

test('records document narration with tracked words and slides side by side', async ({
  page,
}, testInfo) => {
  await openInitializedSite(page);
  await page.getByRole('button', { name: 'New File', exact: true }).click();
  const name = page.getByRole('textbox', { name: 'New file name' });
  await name.fill('narration-slides.md');
  await name.press('Enter');
  const editor = page.locator('.ProseMirror[contenteditable="true"]');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+Shift+2');
  const source = page.locator('.monaco-editor textarea');
  await source.press('ControlOrMeta+A');
  await page.keyboard.insertText(
    '# Introduction\n\nRead these words while the introduction slide is visible.\n\n' +
      '# The idea\n\nExplain the idea while the second slide is visible.\n\n' +
      '# Next steps\n\nFinish the narration with the final slide.\n',
  );
  await source.press('ControlOrMeta+Shift+1');
  await expect(editor.locator('h1')).toHaveCount(3);

  async function openNarration() {
    await page.getByRole('button', { name: 'Insert', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Document narration', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Record document narration' });
    await dialog.getByRole('checkbox', { name: 'Show narration mode' }).check();
    await dialog.getByRole('checkbox', { name: 'Show slides mode' }).check();
    return dialog;
  }

  const dialog = await openNarration();
  const narration = dialog.getByTestId('teleprompter-view');
  const slides = dialog.getByTestId('recorder-slides-panel');
  await expect(narration).toBeVisible();
  await expect(slides).toBeVisible();
  const narrationBox = (await narration.boundingBox())!;
  const slidesBox = (await slides.boundingBox())!;
  expect(slidesBox.x).toBeGreaterThanOrEqual(narrationBox.x + narrationBox.width);
  expect(Math.abs(narrationBox.y - slidesBox.y)).toBeLessThan(2);
  expect(narrationBox.width).toBeGreaterThan(300);
  await dialog.getByLabel('Countdown', { exact: true }).selectOption('0');
  await dialog.getByRole('button', { name: 'Start preview', exact: true }).click();
  const controls = dialog.getByTestId('teleprompter-controls');
  await expect(controls).toHaveAttribute('data-mic-status', 'live');
  await dialog.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(controls).toHaveAttribute('data-transport', 'rolling');
  await expect(controls).toHaveAttribute('data-voice-live', 'true');
  await expect(narration.locator('.squisq-teleprompter-word--active')).toHaveCount(1);
  await waitForRecordingSecond(dialog, 1);
  await slides.getByRole('button', { name: 'Next slide' }).click();
  await expect(slides.getByText('Slide 2 of 3')).toBeVisible();
  await page.screenshot({ path: 'reports/narration-recording/combined.png' });
  await waitForRecordingSecond(dialog, 2);
  await slides.getByRole('button', { name: 'Next slide' }).click();
  await waitForRecordingSecond(dialog, 3);
  await dialog.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(controls).toHaveAttribute('data-transport', 'paused');
  await expect(dialog.getByLabel('Update block timings when I save this narration')).toBeChecked();
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('link', { name: 'Download recording timings' }).click();
  const download = await downloadPromise;
  const timingPath = testInfo.outputPath('narration.timing.json');
  await download.saveAs(timingPath);
  const timing = JSON.parse(await readFile(timingPath, 'utf8'));
  expect(timing.generator.method).toBe('presenter-advance');
  expect(timing.blocks).toHaveLength(3);
  expect(timing.blocks[0].startSec).toBe(0);
  expect(timing.blocks[1].startSec).toBeGreaterThan(0.8);
  expect(timing.blocks[2].startSec).toBeGreaterThan(timing.blocks[1].startSec);
  expect(timing.blocks[2].endSec).toBe(timing.duration);
  await dialog.getByRole('button', { name: 'Save to document', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(editor.locator('video')).toHaveCount(1);

  // The optional reading aid must preserve the entry's replace-take behavior.
  const replacement = await openNarration();
  await replacement.getByRole('button', { name: 'Start preview', exact: true }).click();
  await replacement.getByRole('button', { name: 'Record', exact: true }).click();
  await waitForRecordingSecond(replacement, 1);
  await replacement.getByRole('button', { name: 'Stop', exact: true }).click();
  await replacement.getByRole('button', { name: 'Save to document', exact: true }).click();
  await expect(replacement).toBeHidden();
  await expect(editor.locator('video')).toHaveCount(1);
});
