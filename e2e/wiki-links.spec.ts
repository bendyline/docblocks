import { expect, test } from './helpers/test.js';
import { openInitializedSite } from './helpers/site.js';
import { MONACO_COLD_LOAD_TIMEOUT } from './helpers/editor-regression.js';

test('wiki completion drills into folders in Write and Source and preserves friendly names', async ({
  page,
}) => {
  await openInitializedSite(page);
  await page.getByRole('button', { name: 'New File', exact: true }).click();
  await page.getByRole('textbox', { name: 'New file name' }).fill('wiki-completion.md');
  await page.getByRole('textbox', { name: 'New file name' }).press('Enter');
  const editor = page.getByRole('textbox', { name: /^Edit \/?wiki-completion\.md$/ });
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await editor.pressSequentially('[[reference/Alpha|Friendly article]]');
  await page
    .getByRole('button', {
      name: 'Create article: Friendly article (reference/Alpha)',
      exact: true,
    })
    .click();
  const article = page.getByRole('textbox', { name: /^Edit \/?reference\/Alpha\.md$/ });
  await expect(article).toBeVisible();
  await article.click();
  await page.keyboard.insertText('The article behind the friendly name');
  await page
    .locator(
      '.db-tree-row[data-path="wiki-completion.md"], .db-tree-row[data-path="/wiki-completion.md"]',
    )
    .click();
  await expect(editor).toBeVisible();
  await editor.click();
  await editor.press('ControlOrMeta+End');
  await editor.press('Enter');
  await editor.pressSequentially('[[ref');
  const menu = page.getByRole('listbox', { name: 'Wiki articles and folders' });
  await expect(menu.getByRole('option', { name: 'reference/', exact: true })).toBeVisible();
  await editor.press('Enter');
  await expect(menu.getByRole('option', { name: 'Alpha', exact: true })).toBeVisible();
  await editor.press('Tab');
  await expect(
    page.getByRole('button', { name: 'Open article: reference/Alpha', exact: true }),
  ).toBeVisible();
  await expect(menu).toHaveCount(0);

  // Completion leaves the caret beside the wiki node: Ctrl+K edits that node.
  await editor.press('ControlOrMeta+k');
  const wikiDialog = page.getByRole('dialog', { name: 'Edit wiki link', exact: true });
  await expect(wikiDialog.getByLabel('Article target')).toHaveValue('reference/Alpha');
  await expect(wikiDialog.getByLabel('Friendly name')).toHaveValue('');
  await expect(wikiDialog).toContainText('Internal article link');
  await wikiDialog.getByLabel('Friendly name').fill('Completed article');
  await wikiDialog.getByRole('button', { name: 'Update', exact: true }).click();
  const completed = page.getByRole('button', {
    name: 'Open article: Completed article (reference/Alpha)',
    exact: true,
  });
  await expect(completed).toBeVisible();
  const original = page.getByRole('button', {
    name: 'Open article: Friendly article (reference/Alpha)',
    exact: true,
  });
  await expect(original).toBeVisible();
  await completed.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit wiki link', exact: true }).click();
  await expect(wikiDialog.getByLabel('Article target')).toHaveValue('reference/Alpha');
  await expect(wikiDialog.getByLabel('Friendly name')).toHaveValue('Completed article');
  await wikiDialog.getByLabel('Article target').fill('../outside');
  await expect(wikiDialog.getByRole('button', { name: 'Update', exact: true })).toBeDisabled();
  await wikiDialog.getByLabel('Article target').fill('reference/Alpha');
  await wikiDialog.getByLabel('Friendly name').fill('Edited friendly name');
  await wikiDialog.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(original).toBeVisible();

  await editor.press('ControlOrMeta+End');
  await editor.press('Enter');
  await editor.pressSequentially('[[ref');
  await expect(menu).toBeVisible();
  await editor.press('Escape');
  await expect(menu).toHaveCount(0);
  for (let i = 0; i < 5; i++) await editor.press('Backspace');
  await expect(original).toBeVisible();

  await page.locator('[data-view="raw"]').click();
  const monaco = page.locator('.monaco-editor').first();
  await expect(monaco).toBeVisible({ timeout: MONACO_COLD_LOAD_TIMEOUT });
  await monaco.locator('textarea').focus();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('[[ref');
  const suggestions = monaco.locator('.suggest-widget.visible');
  await expect(suggestions).toContainText('reference/');
  await page.keyboard.press('Enter');
  await expect(suggestions).toContainText('Alpha');
  await page.keyboard.press('Enter');
  await expect(monaco.locator('.view-lines')).toContainText('[[reference/Alpha]]');
  await page.keyboard.press('ControlOrMeta+k');
  await expect(wikiDialog.getByLabel('Article target')).toHaveValue('reference/Alpha');
  await expect(wikiDialog.getByLabel('Friendly name')).toHaveValue('');
  await wikiDialog.getByLabel('Friendly name').fill('Source caption');
  await wikiDialog.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(monaco.locator('.view-lines')).toContainText('[[reference/Alpha|Source caption]]');
  await expect(monaco.locator('.view-lines')).toContainText(
    '[[reference/Alpha|Edited friendly name]]',
  );
  await expect(monaco.locator('.view-lines')).toContainText('[[reference/Alpha|Friendly article]]');
  await page.locator('[data-view="wysiwyg"]').click();
  await page
    .getByRole('button', { name: 'Open article: Friendly article (reference/Alpha)', exact: true })
    .click();
  await expect(article).toContainText('The article behind the friendly name');
});

test('wiki link editing can change a target and clear its friendly name', async ({ page }) => {
  await openInitializedSite(page);
  await page.getByRole('button', { name: 'New File', exact: true }).click();
  await page.getByRole('textbox', { name: 'New file name' }).fill('wiki-edit.md');
  await page.getByRole('textbox', { name: 'New file name' }).press('Enter');
  const editor = page.getByRole('textbox', { name: /^Edit \/?wiki-edit\.md$/ });
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await page.locator('[data-view="raw"]').click();
  const monaco = page.locator('.monaco-editor').first();
  await expect(monaco).toBeVisible({ timeout: MONACO_COLD_LOAD_TIMEOUT });
  await monaco.locator('textarea').focus();
  await page.keyboard.insertText('**[[first|Old name]]** and [[second|Keep me]]');
  await page.locator('[data-view="wysiwyg"]').click();
  const original = page.getByRole('button', {
    name: 'Create article: Old name (first)',
    exact: true,
  });
  await original.focus();
  await page.keyboard.press('ControlOrMeta+k');
  const dialog = page.getByRole('dialog', { name: 'Edit wiki link', exact: true });
  await expect(dialog.getByLabel('Article target')).toHaveValue('first');
  await expect(dialog.getByLabel('Friendly name')).toHaveValue('Old name');
  await dialog.getByLabel('Article target').fill('reference/third.html');
  await dialog.getByLabel('Friendly name').fill('New name');
  await dialog.getByRole('button', { name: 'Update', exact: true }).click();
  const changed = page.getByRole('button', {
    name: 'Create article: New name (reference/third.html)',
    exact: true,
  });
  await expect(changed).toBeEnabled();
  await expect(
    editor.locator('strong').getByRole('button', {
      name: 'Create article: New name (reference/third.html)',
      exact: true,
    }),
  ).toBeVisible();
  await changed.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit wiki link', exact: true }).click();
  await dialog.getByLabel('Friendly name').fill('');
  await dialog.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Create article: reference/third.html', exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole('button', { name: 'Create article: Keep me (second)', exact: true }),
  ).toBeVisible();
  await page.locator('[data-view="raw"]').click();
  await expect(monaco).toBeVisible({ timeout: MONACO_COLD_LOAD_TIMEOUT });
  await expect(monaco.locator('.view-lines')).toContainText(
    '**[[reference/third.html]]** and [[second|Keep me]]',
  );
  // A right-click inside a larger selection still edits the clicked article.
  await monaco.locator('textarea').focus();
  await page.keyboard.press('ControlOrMeta+a');
  await monaco
    .locator('.view-line')
    .filter({ hasText: '[[reference/third.html]]' })
    .click({
      button: 'right',
      position: { x: 35, y: 10 },
    });
  await page.getByRole('menuitem', { name: 'Edit wiki link', exact: true }).click();
  await expect(dialog.getByLabel('Article target')).toHaveValue('reference/third.html');
  await expect(dialog.getByLabel('Friendly name')).toHaveValue('');
  await dialog.getByLabel('Friendly name').fill('Source menu name');
  await dialog.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(monaco.locator('.view-lines')).toContainText(
    '**[[reference/third.html|Source menu name]]** and [[second|Keep me]]',
  );
});

test('an HTML workspace default creates wiki pages outside-in beside the public document', async ({
  page,
}) => {
  await openInitializedSite(page);
  // Monaco's keymap follows the emulated browser, not Playwright's host OS.
  const modifier = await page.evaluate(() =>
    navigator.userAgent.includes('Macintosh') ? 'Meta' : 'Control',
  );
  const appendBodyParagraph = async (text: string) => {
    await page.getByRole('tab', { name: 'Source', exact: true }).click();
    const monaco = page.locator('.monaco-editor').first();
    await expect(monaco).toBeVisible({ timeout: MONACO_COLD_LOAD_TIMEOUT });
    const input = monaco.locator('textarea');
    await input.press(`${modifier}+a`);
    await input.press('ArrowRight');
    await page.keyboard.insertText(`\n${text}\n`);
    await expect(monaco.locator('.view-lines')).toContainText(text);
    await page.getByRole('tab', { name: 'Write', exact: true }).click();
  };
  await page.keyboard.press('ControlOrMeta+KeyN');
  const dialog = page.getByRole('dialog', { name: 'New document' });
  await dialog.getByLabel('Type').selectOption('web-static');
  await dialog.getByLabel('Document name').fill('wiki-html');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  const source = page.getByRole('textbox', { name: /^Edit \/?wiki-html_files\/wiki-html\.md$/ });
  await expect(source).toBeVisible({ timeout: 30_000 });
  // Seed a body link through Source, preserving the outside-in frontmatter.
  // A Write-view end shortcut can land beside the heading's inert badges and
  // turn this fixture into a heading link instead of the intended paragraph.
  await appendBodyParagraph('[[reference/blah]]');
  await expect(source.locator(':scope > h1 + p')).toHaveText('reference/blah');
  await page.getByRole('button', { name: 'Create article: reference/blah', exact: true }).click();
  await expect(page).toHaveURL(/reference%2Fblah\.html$|reference\/blah\.html$/);
  const article = page.getByRole('textbox', { name: /^Edit \/?reference\/blah_files\/blah\.md$/ });
  await expect(article).toBeVisible();
  await appendBodyParagraph('Saved through the HTML companion');
  await expect(article.locator(':scope > h1 + p')).toHaveText('Saved through the HTML companion');
  await page
    .locator('.db-tree-row[data-path="wiki-html.html"], .db-tree-row[data-path="/wiki-html.html"]')
    .click();
  await expect(
    page.getByRole('button', { name: 'Open article: reference/blah', exact: true }),
  ).toBeEnabled();
  await page.locator('[data-view="preview"]').click();
  await page.getByRole('button', { name: 'Next slide', exact: true }).click();
  const link = page.getByTestId('preview-panel').locator('a[href="/reference/blah.html"]');
  await link.click({ timeout: 10_000 });
  await expect(article).toContainText('Saved through the HTML companion');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(article).toContainText('Saved through the HTML companion', { timeout: 30_000 });
});

test('wiki articles create on follow, preserve the source, and reopen without overwriting', async ({
  page,
}) => {
  await openInitializedSite(page);
  await page.getByRole('button', { name: 'New File', exact: true }).click();
  await page.getByRole('textbox', { name: 'New file name' }).fill('wiki-source.md');
  await page.getByRole('textbox', { name: 'New file name' }).press('Enter');
  const editor = page.getByRole('textbox', { name: /^Edit \/?wiki-source\.md$/ });
  await expect(editor).toBeVisible({ timeout: 15_000 });
  const sourceUrl = page.url();
  await editor.click();
  await editor.pressSequentially('Wiki source [[reference/blah]]');
  const create = page.getByRole('button', { name: 'Create article: reference/blah', exact: true });
  await expect(create).toBeEnabled();
  await expect(editor).toHaveText('Wiki source reference/blah');

  // Rendering a presentation must neither link nor create a missing article.
  await page.locator('[data-view="preview"]').click();
  await page.getByRole('button', { name: 'Next slide', exact: true }).click();
  await expect(page.getByTestId('preview-panel')).toContainText('reference/blah');
  await expect(
    page.getByTestId('preview-panel').locator('a[href="reference/blah.md"]'),
  ).toHaveCount(0);
  await page.locator('[data-view="wysiwyg"]').click();
  await create.click();
  await expect(page).toHaveURL(/reference%2Fblah\.md$|reference\/blah\.md$/);
  const article = page.getByRole('textbox', { name: /^Edit \/?reference\/blah\.md$/ });
  await expect(article).toBeVisible();
  await article.click();
  await page.keyboard.insertText('Keep this article content');

  await page
    .locator('.db-tree-row[data-path="wiki-source.md"], .db-tree-row[data-path="/wiki-source.md"]')
    .click();
  await expect(page).toHaveURL(sourceUrl);
  await expect(
    page.getByRole('button', { name: 'Open article: reference/blah', exact: true }),
  ).toBeEnabled();
  await expect(editor).toContainText('Wiki source');
  await page.locator('[data-view="preview"]').click();
  await page.getByRole('button', { name: 'Next slide', exact: true }).click();
  const existing = page.getByTestId('preview-panel').locator('a[href="reference/blah.md"]');
  await expect(existing).toBeVisible();
  await existing.click({ timeout: 10_000 });
  await expect(article).toContainText('Keep this article content');
});

test('traversal wiki syntax remains inert in Write mode', async ({ page }) => {
  await openInitializedSite(page);
  await page.getByRole('button', { name: 'New File', exact: true }).click();
  await page.getByRole('textbox', { name: 'New file name' }).fill('wiki-traversal.md');
  await page.getByRole('textbox', { name: 'New file name' }).press('Enter');
  const editor = page.getByRole('textbox', { name: /^Edit \/?wiki-traversal\.md$/ });
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await editor.pressSequentially('[[../outside]]');
  await expect(editor).toContainText('[[../outside]]');
  await expect(editor.locator('.squisq-wiki-link')).toHaveCount(0);
});
