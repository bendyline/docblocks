/**
 * Workspace search as it ships: the electron-builder output, under
 * production fuses, with the real bundled embedding model (packaged builds
 * ignore the e2e stand-in). Covers what only a packaged build can break —
 * the index worker and `sqlite3.wasm` loading from app.asar over `app://`,
 * the origin-private store, the embedding utility process loading ONNX
 * Runtime from app.asar.unpacked, and the model read from
 * `resources/embedding-model` with no download.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './packaged-fixtures.js';

async function openSearch(window: Page) {
  await window.waitForSelector('.db-shell', { timeout: 60_000 });
  const input = window.getByRole('searchbox', { name: 'Search workspace' });
  await expect(async () => {
    await window.locator('.db-shell').click({ position: { x: 5, y: 5 } });
    await window.keyboard.press('ControlOrMeta+Shift+f');
    await expect(input).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  return input;
}

test('searches the workspace by meaning on the bundled model, from a persistent index', async ({
  launchPackagedApp,
  workspaceDir,
}) => {
  fs.mkdirSync(path.join(workspaceDir, 'garden'), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, 'garden', 'pests.md'),
    '# Garden notes\n\n## Under the leaves\n\nAphids gather under the leaves of the roses; a soap spray clears them in two days.\n',
  );
  fs.writeFileSync(
    path.join(workspaceDir, 'kitchen.md'),
    '# Kitchen\n\nRoast the tomatoes slowly with garlic and a little olive oil.\n',
  );
  fs.writeFileSync(
    path.join(workspaceDir, 'car.md'),
    '# Car\n\nThe tyres were rotated in March; next service at 60,000 km.\n',
  );

  const packaged = await launchPackagedApp();
  const { window } = packaged;
  const input = await openSearch(window);
  const panel = window.locator('section.db-search-panel');
  await expect(panel).toHaveAttribute('data-index-persistence', 'persistent', { timeout: 60_000 });
  expect(await window.evaluate(() => navigator.storage.persisted())).toBe(true);

  const status = await window.evaluate(async () => {
    type Embeddings = import('@bendyline/docblocks/host').DocBlocksHostEmbeddingsAPI;
    const host = (globalThis as { docBlocksHost?: { embeddings?: Embeddings } }).docBlocksHost;
    return host?.embeddings ? await host.embeddings.status() : null;
  });
  expect(status).toMatchObject({ state: 'ready' });

  // Every passage embedded by the real model.
  await window.locator('.db-app-menu-btn').click();
  await window.getByRole('menuitem', { name: 'Settings' }).click();
  const dialog = window.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('tab', { name: 'Search', exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: 'Search by meaning' })).toBeChecked();
  await expect(dialog.getByTestId('semantic-search-coverage')).toContainText('ready:', {
    timeout: 90_000,
  });
  await window.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // No note says "insects" or "plants": only the model can connect them to aphids on roses.
  await window.getByRole('button', { name: 'Best matches' }).click();
  await expect(panel).toHaveAttribute('data-search-mode', 'ranked');
  await input.fill('insects eating my plants');
  const results = window.getByRole('tree', { name: 'Search results' });
  await expect(results.locator('.db-search-document').first()).toContainText('Garden notes', {
    timeout: 30_000,
  });
  await packaged.close();
});
