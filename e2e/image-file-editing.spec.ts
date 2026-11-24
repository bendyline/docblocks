import { expect, test } from './helpers/test.js';
import { openInitializedSite } from './helpers/site.js';
import { createDocument } from './helpers/new-document.js';

/**
 * An image file opened from the explorer edits in place, outside-in: Squisq's
 * layered editor writes the flattened picture back over the file, and the
 * layers live in a hidden `<name.ext>_files/` companion.
 */
test('edits a PNG from the explorer and keeps its layers with the file', async ({ page }) => {
  test.setTimeout(120_000);
  await openInitializedSite(page);

  // A real, decodable PNG dropped into the workspace is stored byte-for-byte.
  await page
    .locator('.db-file-explorer')
    .first()
    .evaluate(async (explorer) => {
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 100;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#3366cc';
      context.fillRect(0, 0, 160, 100);
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((made) => resolve(made!), 'image/png'),
      );
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], 'sketch.png', { type: 'image/png' }));
      explorer.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
    });

  const imageRow = page.getByRole('treeitem', { name: /sketch\.png/ });
  await expect(imageRow).toBeVisible({ timeout: 30_000 });
  await imageRow.click();

  const editor = page.getByTestId('image-editor');
  await expect(editor).toBeVisible({ timeout: 30_000 });
  const layers = editor.getByTestId('image-editor-layers');
  await expect(layers.getByRole('button', { name: 'Delete layer' })).toHaveCount(1);

  await layers.getByRole('button', { name: 'Add layer' }).click();
  await page.getByRole('menuitem', { name: 'Text layer' }).click();
  await expect(layers.getByRole('button', { name: 'Delete layer' })).toHaveCount(2);

  const save = editor.getByRole('button', { name: 'Save', exact: true });
  await save.click();
  await expect(save).toBeEnabled({ timeout: 30_000 });
  await expect(editor.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: 'reports/image-file-editing/editor.png' });

  // The layers folder never shows in the explorer.
  await expect(page.getByRole('treeitem', { name: /_files/ })).toHaveCount(0);

  // Leave and come back. The layers load again only because the picture on
  // disk is the one Save wrote: a picture that differed from the recorded
  // write-back would have re-seeded them down to the one background layer.
  await createDocument(page, 'elsewhere', { empty: true });
  await expect(editor).toBeHidden();
  await imageRow.click();
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await expect(layers.getByRole('button', { name: 'Delete layer' })).toHaveCount(2);
});

test('opens a GIF in the viewer, not the editor', async ({ page }) => {
  await openInitializedSite(page);
  await page
    .locator('.db-file-explorer')
    .first()
    .evaluate((explorer) => {
      // A 1×1 GIF89a.
      const gif = Uint8Array.from(
        atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),
        (char) => char.charCodeAt(0),
      );
      const transfer = new DataTransfer();
      transfer.items.add(new File([gif], 'loop.gif', { type: 'image/gif' }));
      explorer.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
    });

  const row = page.getByRole('treeitem', { name: /loop\.gif/ });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(page.getByTestId('image-viewer')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('image-editor')).toHaveCount(0);
});
