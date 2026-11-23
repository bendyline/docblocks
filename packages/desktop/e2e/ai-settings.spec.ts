/**
 * AI through the whole desktop stack: Settings UI → preload → IPC → main →
 * the Gezel app SDK loaded by dynamic import → in-process service host.
 *
 * `GEZEL_HOME` points at an empty directory, so the standalone app is absent
 * and the private host is isolated from the developer's models and settings.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';

import { test, expect } from './fixtures.js';

async function readAi(window: Page) {
  return window.evaluate(async () => {
    const ai = (
      globalThis as {
        docBlocksHost?: {
          ai?: {
            providerInstalled(): Promise<boolean>;
            status(): Promise<unknown>;
            getPreferences(): Promise<unknown>;
          };
        };
      }
    ).docBlocksHost?.ai;
    if (!ai) throw new Error('The desktop host exposes no AI namespace');
    return {
      providerInstalled: await ai.providerInstalled(),
      status: await ai.status(),
      preferences: await ai.getPreferences(),
    };
  });
}

async function openAiSettings(window: Page) {
  await window.locator('.db-app-menu-btn').click();
  await window.getByRole('menuitem', { name: 'Settings' }).click();
  const dialog = window.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('tab', { name: 'AI', exact: true }).click();
  return dialog.getByRole('group', { name: 'AI assistance' });
}

test('AI self-hosts without an installed Gezel, and the choice persists', async ({ launchApp }) => {
  const first = await launchApp();
  await first.window.waitForSelector('.db-shell', { timeout: 30_000 });
  expect(await readAi(first.window)).toEqual({
    providerInstalled: false,
    status: { kind: 'unavailable', reason: 'opt-out' },
    preferences: { enabled: false, model: null, reviewMode: 'explicit' },
  });

  const section = await openAiSettings(first.window);
  const optIn = section.getByRole('checkbox', { name: 'Use AI features' });
  await expect(optIn).not.toBeChecked();
  await expect(section).toContainText('run entirely on this device — no account needed');
  await optIn.check();
  await expect
    .poll(async () => (await readAi(first.window)).status, { timeout: 30_000 })
    .toMatchObject({ kind: 'ready', provider: { name: 'Gezel', mode: 'hosted' } });
  // Ready hosted AI shows its model picker; with a model on this device the
  // status line is deliberately empty, so it is no longer the signal.
  // getByLabel would also read the wrapped select's option text.
  await expect(section.getByRole('combobox', { name: 'Model', exact: true })).toBeVisible();
  await expect(section.getByRole('button', { name: 'Connect Gezel app' })).toHaveCount(0);
  // Nothing is downloaded in this isolated home, so when Gezel recommends a
  // download for this machine, Settings leads with it as one action and keeps
  // the full catalog behind "Pick a model…". Hosts Gezel cannot rate offer none.
  const recommended = await first.window.evaluate(async () => {
    const ai = (
      globalThis as {
        docBlocksHost?: {
          ai?: {
            availableModels?(): Promise<
              { ok: true; value: { label: string; recommended: boolean }[] } | { ok: false }
            >;
          };
        };
      }
    ).docBlocksHost?.ai;
    const available = await ai?.availableModels?.();
    return available?.ok
      ? (available.value.find((model) => model.recommended)?.label ?? null)
      : null;
  });
  if (recommended) {
    await expect(
      section.getByRole('button', { name: `Add recommended model (${recommended}, ` }),
    ).toBeVisible();
    await expect(section.getByRole('button', { name: 'Pick a model…' })).toBeVisible();
  }
  await first.close();

  // The opt-in persists; relaunching starts the private service silently.
  const second = await launchApp();
  await second.window.waitForSelector('.db-shell', { timeout: 30_000 });
  await expect
    .poll(async () => (await readAi(second.window)).status, { timeout: 15_000 })
    .toMatchObject({ kind: 'ready', provider: { name: 'Gezel', mode: 'hosted' } });
  expect((await readAi(second.window)).preferences).toEqual({
    enabled: true,
    model: null,
    reviewMode: 'explicit',
  });
});

/** A Mac with 32 GB, as far as the run is concerned (see `automationDeviceFit`). */
const CAPABLE_DEVICE = { DOCBLOCKS_E2E_AI_DEVICE: 'unified:32' };

/** Open a short note, where the AI control lives in the toolbar. */
async function openNote(window: Page, workspaceDir: string) {
  const file = path.join(workspaceDir, 'notes.md');
  if (!fs.existsSync(file)) fs.writeFileSync(file, '# Notes\n\nA first draft.\n', 'utf8');
  await window.waitForSelector('.db-shell', { timeout: 30_000 });
  await window.locator('.db-tree-row[data-path$="notes.md"]').click();
  await expect(
    window.locator('.squisq-editor-content [contenteditable="true"]').first(),
  ).toContainText('A first draft', { timeout: 30_000 });
}

const invitation = (window: Page) => window.getByRole('button', { name: 'AI actions: turn on AI' });

test('a device below the line keeps AI out of the toolbar while it is off', async ({
  launchApp,
  workspaceDir,
}) => {
  const { window } = await launchApp();
  await openNote(window, workspaceDir);
  // Past the moment the invitation would have appeared.
  await window.waitForTimeout(3_000);
  await expect(window.locator('.db-ai-toolbar-trigger')).toHaveCount(0);
});

test('a capable device is invited to turn AI on, and Settings opens ready to add a model', async ({
  launchApp,
  workspaceDir,
}) => {
  const { window } = await launchApp([], CAPABLE_DEVICE);
  await openNote(window, workspaceDir);
  const invite = invitation(window);
  await expect(invite).toBeVisible({ timeout: 15_000 });
  await expect(invite).toHaveAttribute('data-tooltip', 'Turn on AI');

  await invite.click();
  const menu = window.getByRole('menu');
  await expect(menu).toContainText('AI that stays on this device');
  await menu.getByRole('menuitem', { name: /^Turn on AI/ }).click();

  const settings = window.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole('tab', { name: 'AI', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(settings.getByRole('checkbox', { name: 'Use AI features' })).toBeChecked();
  expect((await readAi(window)).preferences).toMatchObject({ enabled: true });
  await expect
    .poll(async () => (await readAi(window)).status, { timeout: 30_000 })
    .toMatchObject({ kind: 'ready', provider: { mode: 'hosted' } });
});

test('"Not now" ends the invitation for good', async ({ launchApp, workspaceDir }) => {
  const first = await launchApp([], CAPABLE_DEVICE);
  await openNote(first.window, workspaceDir);
  const invite = invitation(first.window);
  await expect(invite).toBeVisible({ timeout: 15_000 });
  await invite.click();
  await first.window.getByRole('menuitem', { name: 'Not now' }).click();
  await expect(
    first.window.getByText('You can turn on AI any time in Settings › AI.'),
  ).toBeVisible();
  await expect(first.window.locator('.db-ai-toolbar-trigger')).toHaveCount(0);
  await first.close();

  const second = await launchApp([], CAPABLE_DEVICE);
  await openNote(second.window, workspaceDir);
  await second.window.waitForTimeout(3_000);
  await expect(second.window.locator('.db-ai-toolbar-trigger')).toHaveCount(0);
  expect((await readAi(second.window)).preferences).toMatchObject({ enabled: false });
});
