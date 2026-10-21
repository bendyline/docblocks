import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  type PDFRawStream,
  StandardFonts,
  decodePDFRawStream,
} from 'pdf-lib';
import { MemoryContentContainer } from '@bendyline/squisq/storage';
import { containerToZip, zipToContainer } from '@bendyline/squisq-formats/container';
import { expect, test } from './helpers/test.js';
import { openInitializedSite } from './helpers/site.js';
import { openInsertMenu } from './helpers/toolbar.js';
import { collectRuntimeErrors, unexpectedRuntimeErrors } from './helpers/console-guard.js';
import { readWorkspaceBackup } from '../packages/core/src/workspace/backup.js';

async function newDocument(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'New File', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'New file name' });
  await input.fill(`${name}.md`);
  await input.press('Enter');
  await page.getByRole('tab', { name: 'Write', exact: true }).click();
  await expect(page.locator('.ProseMirror')).toHaveText('');
}

async function restoreFromMenu(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
): Promise<void> {
  await page.locator('.db-app-menu-btn').click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Restore backup…' }).click();
  await (await chooser).setFiles(file);
  await expect(page.getByText(/Restored \d+ workspace\(s\) as new copies/)).toBeVisible();
}

/** Restore exact Markdown bytes as a new workspace, which becomes current. */
async function seedWorkspace(
  page: Page,
  name: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  const seed = new MemoryContentContainer();
  for (const [path, text] of Object.entries(files))
    await seed.writeFile(path, new TextEncoder().encode(text));
  await restoreFromMenu(page, {
    name: `${name}.zip`,
    mimeType: 'application/zip',
    buffer: Buffer.from(await (await containerToZip(seed)).arrayBuffer()),
  });
}

/** The current workspace's files, read back through a real backup download. */
async function backUpCurrentWorkspace(page: Page, path: string): Promise<Map<string, string>> {
  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Back up this workspace' }).click();
  await (await download).saveAs(path);
  const [snapshot] = await readWorkspaceBackup(
    await zipToContainer(await readFile(path)),
    'ignored',
  );
  return new Map(snapshot.files.map((file) => [file.path, new TextDecoder().decode(file.data)]));
}

interface TextShow {
  font: string;
  size: number;
  x: number;
  text: string;
}

/** Every `Tj` on the first page, with the font, size and x it was drawn at. */
async function readFirstPageTextShows(bytes: Uint8Array): Promise<TextShow[]> {
  const pdf = await PDFDocument.load(bytes);
  const page = pdf.getPages()[0]!;
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray() : [contents];
  const operators = streams
    .map((ref) => pdf.context.lookup(ref))
    .map((stream) => new TextDecoder().decode(decodePDFRawStream(stream as PDFRawStream).decode()))
    .join('\n');
  return [
    ...operators.matchAll(
      /\/(\S+) ([\d.]+) Tf[\s\S]*?1 0 0 1 ([\d.]+) [\d.]+ Tm\s*<([0-9A-F]*)> Tj/g,
    ),
  ].map(([, resource, size, x, hex]) => {
    const font = page.node
      .Resources()!
      .lookup(PDFName.of('Font'), PDFDict)
      .get(PDFName.of(resource!));
    const baseFont = pdf.context.lookup(font, PDFDict).get(PDFName.of('BaseFont'));
    return {
      font: baseFont instanceof PDFName ? baseFont.decodeText() : String(baseFont),
      size: Number(size),
      x: Number(x),
      text: (hex!.match(/../g) ?? [])
        .map((byte) => String.fromCharCode(parseInt(byte, 16)))
        .join(''),
    };
  });
}

test('backup ZIP restores in a fresh profile with media, history and original files intact', async ({
  page,
  browser,
  runtimeErrorAllowances,
}, testInfo) => {
  await openInitializedSite(page);
  const legacy = new MemoryContentContainer();
  await legacy.writeFile(
    'notes.md',
    new TextEncoder().encode('# Restored notes\n\nKeep every byte.'),
  );
  await legacy.writeFile('notes_files/.gitignore', new TextEncoder().encode('cache/'));
  await legacy.writeFile('notes_files/photo.png', new Uint8Array([0, 255, 128, 42]));
  await legacy.writeFile('.versions/notes.md/1.md', new TextEncoder().encode('Earlier revision'));
  const legacyBytes = Buffer.from(await (await containerToZip(legacy)).arrayBuffer());
  await restoreFromMenu(page, {
    name: 'My Documents.zip',
    mimeType: 'application/zip',
    buffer: legacyBytes,
  });
  await expect(page.getByRole('treeitem', { name: /notes/ }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Back up this workspace' }).click();
  const archivePath = testInfo.outputPath('round-trip.zip');
  await (await download).saveAs(archivePath);
  const archiveBytes = await readFile(archivePath);
  const [snapshot] = await readWorkspaceBackup(await zipToContainer(archiveBytes), 'ignored');
  expect(snapshot.files.map((file) => file.path).sort()).toEqual(
    (await legacy.listFiles()).map((file) => file.path).sort(),
  );
  for (const file of snapshot.files)
    expect(Buffer.from(file.data)).toEqual(Buffer.from((await legacy.readFile(file.path))!));

  const fresh = await browser.newContext({ baseURL: 'http://localhost:5220' });
  try {
    const restoredPage = await fresh.newPage();
    const readErrors = collectRuntimeErrors(restoredPage);
    await openInitializedSite(restoredPage);
    await newDocument(restoredPage, 'original-note');
    await restoredPage.locator('.ProseMirror').fill('Keep my original workspace.');
    await restoreFromMenu(restoredPage, {
      name: 'round-trip.zip',
      mimeType: 'application/zip',
      buffer: archiveBytes,
    });
    await restoredPage
      .getByRole('treeitem', { name: /^notes/ })
      .first()
      .click();
    await expect(restoredPage.locator('.ProseMirror')).toContainText('Keep every byte.');
    await restoredPage.reload();
    await expect(restoredPage.locator('.ProseMirror')).toContainText('Keep every byte.');
    // A second restore creates another copy; it never overwrites the first.
    await restoreFromMenu(restoredPage, {
      name: 'round-trip.zip',
      mimeType: 'application/zip',
      buffer: archiveBytes,
    });
    await restoredPage
      .getByRole('treeitem', { name: /^notes/ })
      .first()
      .click();
    await expect(restoredPage.locator('.ProseMirror')).toContainText('Keep every byte.');
    await restoredPage.screenshot({ path: testInfo.outputPath('restored-workspace.png') });
    await restoredPage.getByRole('button', { name: /^Switch workspace, current:/ }).click();
    await expect(restoredPage.locator('.db-workspace-dropdown-row')).toHaveCount(3);
    await restoredPage.getByRole('button', { name: 'My Documents', exact: true }).click();
    await restoredPage.getByRole('treeitem', { name: /^original-note/ }).click();
    await expect(restoredPage.locator('.ProseMirror')).toContainText('Keep my original workspace.');
    expect(unexpectedRuntimeErrors(readErrors(), runtimeErrorAllowances)).toEqual([]);
  } finally {
    await fresh.close();
  }
});

test('task lists in table cells survive Source, Write, save, and reload', async ({
  page,
}, testInfo) => {
  await openInitializedSite(page);
  await newDocument(page, 'table-round-trip');
  await page.locator('.ProseMirror').click();
  await openInsertMenu(page);
  await page.getByRole('menuitem', { name: 'Table', exact: true }).click();
  const cell = page.locator('.ProseMirror').locator('th,td').first();
  await cell.click();
  await openInsertMenu(page);
  await page.getByRole('menuitem', { name: 'Task List', exact: true }).click();
  await expect(cell.locator('input[type="checkbox"]')).toHaveCount(3);
  await cell.locator('input[type="checkbox"]').first().check();
  await page.getByRole('treeitem', { name: /^Welcome/ }).click();
  await expect(page.locator('.ProseMirror')).toContainText('DocBlocks');
  await page.getByRole('treeitem', { name: /^table-round-trip/ }).click();
  await expect(cell.locator('input[type="checkbox"]').first()).toBeChecked();
  for (let i = 0; i < 2; i++) {
    await page.getByRole('tab', { name: 'Source', exact: true }).click();
    await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 45_000 });
    await page.getByRole('tab', { name: 'Write', exact: true }).click();
    await expect(cell.locator('input[type="checkbox"]')).toHaveCount(3);
    await expect(cell.locator('input[type="checkbox"]').first()).toBeChecked();
  }
  await page.getByRole('treeitem', { name: /^Welcome/ }).click();
  await expect(page.locator('.ProseMirror')).toContainText('DocBlocks');
  await page.getByRole('treeitem', { name: /^table-round-trip/ }).click();
  await expect(cell.locator('input[type="checkbox"]')).toHaveCount(3);
  await page.reload();
  await expect(cell.locator('input[type="checkbox"]')).toHaveCount(3);
  await expect(cell.locator('input[type="checkbox"]').first()).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('table-preserved.png') });
});

test('opening a document in Write never rewrites the file', async ({ page }, testInfo) => {
  await openInitializedSite(page);
  // Valid Markdown the editor would serialize differently (`*` bullets and
  // `__strong__`), so any save of an unedited document changes these bytes.
  const source = '# Opened only\n\nKeep __this__ spelling.\n\n* first\n* second\n';
  await seedWorkspace(page, 'Opened only', { 'opened-only.md': source, 'other.md': '# Other\n' });
  await page.getByRole('treeitem', { name: /^opened-only/ }).click();
  await expect(page.locator('.ProseMirror')).toContainText('second');
  // Switching documents flushes any pending save of the one being left.
  await page.getByRole('treeitem', { name: /^other/ }).click();
  await expect(page.locator('.ProseMirror')).toContainText('Other');
  const files = await backUpCurrentWorkspace(page, testInfo.outputPath('opened-only.zip'));
  expect(files.get('opened-only.md')).toBe(source);
  expect([...files.keys()].filter((path) => path.startsWith('.versions/opened-only.md/'))).toEqual(
    [],
  );
});

test('table column alignment survives an edit and save', async ({ page }, testInfo) => {
  await openInitializedSite(page);
  await seedWorkspace(page, 'Aligned table', {
    'aligned-table.md':
      '# Aligned\n\n| Left | Center | Right | Plain |\n| :--- | :---: | ---: | --- |\n| a | b | c | d |\n',
    'other.md': '# Other\n',
  });
  await page.getByRole('treeitem', { name: /^aligned-table/ }).click();
  await page.locator('.ProseMirror td').filter({ hasText: /^d$/ }).click();
  await page.keyboard.press('End');
  await page.keyboard.type('x');
  await expect(page.locator('.ProseMirror td').filter({ hasText: /^dx$/ })).toBeVisible();
  await page.getByRole('treeitem', { name: /^other/ }).click();
  await expect(page.locator('.ProseMirror')).toContainText('Other');
  const files = await backUpCurrentWorkspace(page, testInfo.outputPath('aligned-table.zip'));
  const saved = files.get('aligned-table.md') ?? '';
  expect(saved).toContain('dx');
  const delimiter = saved.split('\n').find((line) => /^\|?\s*:?-{3,}/.test(line)) ?? '';
  // `:---` is explicit left and `---` is none; each must be written back as read.
  expect(
    delimiter
      .split('|')
      .map((cell) => cell.trim())
      .filter(Boolean),
  ).toEqual([
    expect.stringMatching(/^:-+$/),
    expect.stringMatching(/^:-+:$/),
    expect.stringMatching(/^-+:$/),
    expect.stringMatching(/^-+$/),
  ]);
});

test('PDF export keeps the space after a kerned word', async ({ page }, testInfo) => {
  await openInitializedSite(page);
  await seedWorkspace(page, 'Kerning', { 'kerning.md': 'Type to add text.\n' });
  await page.getByRole('treeitem', { name: /^kerning/ }).click();
  await expect(page.locator('.ProseMirror')).toContainText('Type to add text.');
  await page.getByRole('button', { name: 'Export and share' }).click();
  await page.getByRole('menuitem', { name: 'Export document...' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export Document' });
  await dialog.getByRole('radio', { name: 'PDF', exact: true }).click();
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: /Save .* to Downloads/ }).click();
  const pdfPath = testInfo.outputPath('kerning.pdf');
  await (await download).saveAs(pdfPath);

  const shows = await readFirstPageTextShows(await readFile(pdfPath));
  const word = shows.findIndex((show) => show.text === 'Type');
  expect(word, JSON.stringify(shows)).toBeGreaterThanOrEqual(0);
  const { font, size, x } = shows[word]!;
  expect(Object.values(StandardFonts)).toContain(font);
  // pdf-lib draws the standard fonts without kerning, so the next run must
  // start where the unkerned glyphs end, not where the kerned measure does.
  const metrics = await (await PDFDocument.create()).embedFont(font as StandardFonts);
  const drawn = [...'Type'].reduce((sum, c) => sum + metrics.widthOfTextAtSize(c, size), 0);
  expect(metrics.widthOfTextAtSize('Type', size)).toBeLessThan(drawn - 0.5);
  expect(shows[word + 1]!.x - x).toBeCloseTo(drawn, 1);
});

for (const width of [320, 390]) {
  test(`custom layouts can be edited and saved at ${width}px`, async ({ page }, testInfo) => {
    await openInitializedSite(page);
    await newDocument(page, `phone-layout-${width}`);
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole('treeitem', { name: new RegExp(`^phone-layout-${width}`) }).click();
    const more = page.locator('.squisq-toolbar-overflow-trigger');
    await more.click();
    await page.getByRole('button', { name: 'Custom layouts', exact: true }).last().click();
    const dialog = page.getByRole('dialog', { name: 'Custom layouts', exact: true });
    await expect(dialog).toBeVisible();
    const designer = dialog.locator('.squisq-template-designer-panel');
    await expect
      .poll(() => designer.evaluate((element) => element.clientWidth))
      .toBeGreaterThan(width - 80);
    const label = designer.getByRole('textbox', { name: 'Label', exact: true });
    await label.fill('Phone layout');
    await expect(designer.getByRole('textbox', { name: /^Name/ })).toHaveValue('phone-layout');
    // Insert a built-in placeholder with a tap, then save using the normal UI.
    await designer.getByRole('button', { name: '{title} Title', exact: true }).first().click();
    await designer
      .locator('.squisq-template-designer-scene')
      .click({ position: { x: 120, y: 110 } });
    const save = designer.getByRole('button', { name: 'Save to this doc', exact: true });
    await save.scrollIntoViewIfNeeded();
    const box = await save.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`phone-layout-${width}.png`) });
    await save.click();
    await expect(dialog.getByRole('button', { name: /Phone layout/ }).first()).toBeVisible();
  });
}

test('unsupported PDF text is blocked before download and Word remains available', async ({
  page,
}, testInfo) => {
  await openInitializedSite(page);
  await newDocument(page, 'unicode-export');
  await page.locator('.ProseMirror').fill('日本語のテキスト');
  await page.getByRole('treeitem', { name: /^Welcome/ }).click();
  await expect(page.locator('.ProseMirror')).toContainText('DocBlocks');
  await page.getByRole('treeitem', { name: /^unicode-export/ }).click();
  await expect(page.locator('.ProseMirror')).toContainText('日本語のテキスト');
  await page.getByRole('button', { name: 'Export and share' }).click();
  await page.getByRole('menuitem', { name: 'Export document...' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export Document' });
  await dialog.getByRole('radio', { name: 'PDF', exact: true }).click();
  const downloads: string[] = [];
  page.on('download', (download) => downloads.push(download.suggestedFilename()));
  await dialog.getByRole('button', { name: /Save .* to Downloads/ }).click();
  await expect(dialog.getByRole('alert')).toContainText('PDF was not saved', { timeout: 30_000 });
  expect(downloads).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('pdf-fidelity-error.png') });
  await dialog.getByRole('radio', { name: 'Word', exact: true }).click();
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: /Save .* to Downloads/ }).click();
  const word = await download;
  expect(word.suggestedFilename()).toMatch(/\.docx$/);
  const wordPath = testInfo.outputPath('unicode-export.docx');
  await word.saveAs(wordPath);
  const wordContainer = await zipToContainer(await readFile(wordPath));
  const documentXml = await wordContainer.readFile('word/document.xml');
  expect(documentXml).not.toBeNull();
  expect(new TextDecoder().decode(documentXml!)).toContain('日本語のテキスト');
});
