import { expect, test } from './helpers/test.js';
import { openInitializedSite } from './helpers/site.js';

/**
 * Video and audio files dropped onto a document are stored beside it and
 * inserted as inline players — on the page, on the desk around it, or on the
 * Attachments panel — instead of being claimed by the document importer.
 */

/** Drop one file on `element` at `point` (viewport coordinates). */
function dropFile(
  element: HTMLElement | SVGElement,
  file: { name: string; type: string; point?: 'page' | 'left-edge' },
): void {
  const box = element.getBoundingClientRect();
  const transfer = new DataTransfer();
  transfer.items.add(
    new File([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], file.name, {
      type: file.type,
    }),
  );
  element.dispatchEvent(
    new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
      clientX: file.point === 'left-edge' ? box.x + 2 : box.x + 40,
      clientY: box.y + 20,
    }),
  );
}

test('inserts dropped video and audio as players wherever it lands', async ({ page }) => {
  await openInitializedSite(page);
  await page.getByRole('button', { name: 'New File', exact: true }).click();
  const name = page.getByRole('textbox', { name: 'New file name' });
  await name.fill('media-drop.md');
  await name.press('Enter');
  const editor = page.getByRole('textbox', { name: /^Edit \/?media-drop\.md$/ });
  await expect(editor).toBeVisible({ timeout: 15_000 });
  // Body text first: leading media in an otherwise empty document collapses
  // into the document tray rather than rendering inline.
  await editor.click();
  await page.keyboard.type('Intro');
  await expect(editor).toContainText('Intro');

  // On the page.
  await editor.evaluate(dropFile, { name: 'clip.mp4', type: 'video/mp4' });
  await expect(editor.locator('[data-squisq-media-kind="video"]')).toHaveAttribute(
    'data-squisq-media-src',
    /clip\.mp4$/,
    { timeout: 15_000 },
  );

  // On the desk beside the page, outside ProseMirror's own element.
  await page
    .getByTestId('wysiwyg-container')
    .evaluate(dropFile, { name: 'take.mp3', type: 'audio/mpeg', point: 'left-edge' });
  await expect(editor.locator('[data-squisq-media-kind="audio"]')).toHaveAttribute(
    'data-squisq-media-src',
    /take\.mp3$/,
    { timeout: 15_000 },
  );

  // On the Attachments panel, with no MIME type from the OS.
  await page.getByRole('button', { name: /^Attachments/ }).click();
  const bin = page.locator('.squisq-media-bin');
  await expect(bin.getByText('clip.mp4')).toBeVisible();
  await bin.evaluate(dropFile, { name: 'voice.m4a', type: '' });
  await expect(bin.getByText('voice.m4a')).toBeVisible({ timeout: 15_000 });
  await expect(bin.locator('[data-media-path$="voice.m4a"]')).toHaveAttribute(
    'title',
    /\naudio\/mp4\n/,
  );
  await expect(editor.locator('[data-squisq-media-src$="voice.m4a"]')).toHaveAttribute(
    'data-squisq-media-kind',
    'audio',
  );
  await expect(editor.locator('[data-squisq-media-kind]')).toHaveCount(3);
});
