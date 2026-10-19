import { expect, test } from './helpers/test.js';
import { MONACO_COLD_LOAD_TIMEOUT } from './helpers/editor-regression.js';
import { openInitializedSite } from './helpers/site.js';

test('shows image upload progress, embeds durable media, and replaces broken image glyphs', async ({
  page,
}, testInfo) => {
  const imageRequests: string[] = [];
  page.on('request', (request) => {
    if (/dropped-photo\.png|missing-photo\.png/.test(request.url()))
      imageRequests.push(request.url());
  });
  await openInitializedSite(page);
  await page.getByRole('button', { name: 'New File', exact: true }).click();
  const name = page.getByRole('textbox', { name: 'New file name' });
  await name.fill('image-loading.md');
  await name.press('Enter');
  // The welcome document's editor is in Write too until this one replaces it.
  const editor = page.getByRole('textbox', { name: /^Edit \/?image-loading\.md$/ });
  await expect(editor).toBeVisible({ timeout: 15_000 });

  const drop = await editor.evaluateHandle((element) => {
    const bytes = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5ZkAAAAASUVORK5CYII=',
      ),
      (character) => character.charCodeAt(0),
    );
    const file = new File([bytes], 'dropped-photo.png', { type: 'image/png' });
    const read = file.arrayBuffer.bind(file);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    file.arrayBuffer = async () => {
      await gate;
      return read();
    };
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const box = element.getBoundingClientRect();
    const started = performance.now();
    element.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
        clientX: box.x + 40,
        clientY: box.y + 20,
      }),
    );
    return { release, started };
  });
  await expect(editor.getByRole('status')).toContainText('Adding image');
  await expect(editor.locator('img')).toHaveCount(0);
  await editor
    .locator('.squisq-image-placeholder')
    .screenshot({ path: 'reports/image-drop/pending.png' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('.db-shell')).toHaveAttribute('data-theme', 'dark');
  await editor
    .locator('.squisq-image-placeholder')
    .screenshot({ path: 'reports/image-drop/pending-dark.png' });
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('.db-shell')).toHaveAttribute('data-theme', 'light');
  await drop.evaluate((value) => value.release());
  const image = editor.locator('img');
  await expect(image).toBeVisible();
  await expect(image).toHaveJSProperty('naturalWidth', 1);
  await expect(editor.getByRole('status')).toHaveCount(0);
  await expect(editor.locator('figure')).toHaveAttribute('data-image-state', 'ready');
  await drop.dispose();

  // The source contains a portable durable reference, and no upload marker.
  await page.locator('[data-view="raw"]').click();
  const lines = page.locator('.monaco-editor .view-lines');
  // Source shows a busy plain textarea until this page's first Monaco mount
  // finishes loading, which routinely outlasts the default expect timeout.
  await expect(lines).toContainText('image-loading_files/dropped-photo.png', {
    timeout: MONACO_COLD_LOAD_TIMEOUT,
  });
  await expect(lines).not.toContainText('data:image');
  const source = page.locator('.monaco-editor textarea');
  // Monaco chooses shortcuts from the browser's user agent. ControlOrMeta
  // follows the test host instead, so it sends Cmd+A on macOS even when the
  // Desktop Chrome device emulates Windows, leaving the old image in place.
  const selectAll = await source.evaluate(() =>
    navigator.userAgent.includes('Macintosh') ? 'Meta+A' : 'Control+A',
  );
  await source.press(selectAll);
  await page.keyboard.insertText('# Missing image\n\n![Example photo](missing-photo.png)\n');
  await expect(lines).toContainText('![Example photo](missing-photo.png)');
  await expect(lines).not.toContainText('dropped-photo.png');
  await page.locator('[data-view="wysiwyg"]').click();
  const failed = editor.getByRole('img', { name: 'Image unavailable: Example photo' });
  await expect(failed).toBeVisible();
  await expect(editor.locator('img')).toHaveCount(0);
  await failed.screenshot({ path: 'reports/image-drop/unavailable.png' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('.db-shell')).toHaveAttribute('data-theme', 'dark');
  await failed.screenshot({ path: 'reports/image-drop/unavailable-dark.png' });
  await testInfo.attach('pending image', {
    path: 'reports/image-drop/pending.png',
    contentType: 'image/png',
  });
  await testInfo.attach('unavailable image', {
    path: 'reports/image-drop/unavailable.png',
    contentType: 'image/png',
  });
  expect(imageRequests).toEqual([]);
});
