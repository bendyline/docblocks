import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

/**
 * The workspace index runs in a worker over an origin-private SQLite store:
 * it reports itself persistent, keeps working across a relaunch, and offers
 * Best matches (ranked passages) beside literal search.
 */

async function openSearch(window: Page) {
  await window.waitForSelector('.db-shell', { timeout: 30_000 });
  await window.locator('.db-shell').click({ position: { x: 5, y: 5 } });
  await window.keyboard.press('ControlOrMeta+Shift+f');
  const input = window.getByRole('searchbox', { name: 'Search workspace' });
  await expect(input).toBeVisible();
  return input;
}

test('keeps a persistent index across relaunch and ranks passages', async ({
  launchApp,
  workspaceDir,
}) => {
  fs.mkdirSync(path.join(workspaceDir, 'garden'), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, 'garden', 'pests.md'),
    '# Garden pests\n\n## Aphids\n\nAphids gather under the leaves; a soap spray clears them.\n',
  );
  fs.writeFileSync(
    path.join(workspaceDir, 'kitchen.md'),
    '# Kitchen\n\nRoast the tomatoes slowly with garlic.\n',
  );

  const first = await launchApp();
  let input = await openSearch(first.window);
  const panel = first.window.locator('section.db-search-panel');
  await expect(panel).toHaveAttribute('data-index-persistence', 'persistent', { timeout: 30_000 });

  await input.fill('soap spray');
  const results = first.window.getByRole('tree', { name: 'Search results' });
  await expect(results.locator('.db-search-document', { hasText: 'Garden pests' })).toBeVisible({
    timeout: 30_000,
  });

  const best = first.window.getByRole('button', { name: 'Best matches' });
  await best.click();
  await expect(panel).toHaveAttribute('data-search-mode', 'ranked');
  await input.fill('tomato garlic');
  await expect(results.locator('.db-search-document').first()).toContainText('Kitchen', {
    timeout: 30_000,
  });
  await expect(first.window.locator('.db-search-status')).toContainText('best first');
  await first.close();

  const second = await launchApp();
  input = await openSearch(second.window);
  await expect(second.window.locator('section.db-search-panel')).toHaveAttribute(
    'data-index-persistence',
    'persistent',
    { timeout: 30_000 },
  );
  await input.fill('Aphids');
  await expect(
    second.window
      .getByRole('tree', { name: 'Search results' })
      .locator('.db-search-document', { hasText: 'Garden pests' }),
  ).toBeVisible({ timeout: 30_000 });
});

test('finds a note by meaning once the workspace is embedded', async ({
  launchApp,
  workspaceDir,
}) => {
  fs.mkdirSync(path.join(workspaceDir, 'garden'), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, 'garden', 'pests.md'),
    '# Garden notes\n\n## Under the leaves\n\nAphids gather under the leaves; a soap spray clears them.\n',
  );
  fs.writeFileSync(
    path.join(workspaceDir, 'kitchen.md'),
    '# Kitchen\n\nRoast the tomatoes slowly with garlic.\n',
  );

  const app = await launchApp();
  const { window } = app;
  await window.waitForSelector('.db-shell', { timeout: 30_000 });
  // The fixture runs the stand-in model, so the bridge is present.
  expect(
    await window.evaluate(async () => {
      const host = (
        window as unknown as {
          docBlocksHost?: { embeddings?: { status(): Promise<{ state: string }> } };
        }
      ).docBlocksHost;
      return (await host?.embeddings?.status())?.state;
    }),
  ).toBe('ready');

  // Settings shows the open workspace filling in, then ready.
  await window.locator('.db-app-menu-btn').click();
  await window.getByRole('menuitem', { name: 'Settings' }).click();
  const dialog = window.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('tab', { name: 'Search', exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: 'Search by meaning' })).toBeChecked();
  await expect(dialog.getByTestId('semantic-search-coverage')).toContainText('ready:', {
    timeout: 60_000,
  });
  await window.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // No note contains "insects"; only the meaning arm can find the aphids.
  const input = await openSearch(window);
  await window.getByRole('button', { name: 'Best matches' }).click();
  await input.fill('insects');
  const results = window.getByRole('tree', { name: 'Search results' });
  await expect(results.locator('.db-search-document').first()).toContainText('Garden notes', {
    timeout: 30_000,
  });
  await expect(results.locator('.db-search-document', { hasText: 'Kitchen' })).toHaveCount(0);

  // Literal search keeps exact semantics: nothing matches the word.
  await window.getByRole('button', { name: 'Best matches' }).click();
  await input.fill('insectsx');
  await input.fill('insects');
  await expect(window.locator('section.db-search-panel')).toHaveAttribute(
    'data-search-mode',
    'literal',
  );
  await expect(results.locator('.db-search-document')).toHaveCount(0, { timeout: 30_000 });
});
