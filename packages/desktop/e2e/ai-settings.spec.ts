/**
 * AI through the whole desktop stack: Settings UI → preload → IPC → main →
 * the Gezel app SDK loaded by dynamic import → in-process service host.
 *
 * `GEZEL_HOME` points at an empty directory, so the standalone app is absent
 * and the private host is isolated from the developer's models and settings.
 */

import fs from 'node:fs';
import os from 'node:os';
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
  return dialog.getByRole('group', { name: 'AI assistance' });
}

test('AI self-hosts without an installed Gezel, and the choice persists', async ({ launchApp }) => {
  const gezelHome = fs.mkdtempSync(path.join(os.tmpdir(), 'docblocks-e2e-gezel-home-'));
  const previousHome = process.env.GEZEL_HOME;
  process.env.GEZEL_HOME = gezelHome;
  try {
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
    await expect(section).toContainText('DocBlocks runs a private Gezel service inside this app');
    await optIn.check();
    await expect
      .poll(async () => (await readAi(first.window)).status, { timeout: 30_000 })
      .toMatchObject({ kind: 'ready', provider: { name: 'Gezel', mode: 'hosted' } });
    await expect(section.getByRole('status')).toContainText('inside DocBlocks');
    await expect(section.getByRole('button', { name: 'Connect Gezel app' })).toHaveCount(0);
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
  } finally {
    if (previousHome === undefined) delete process.env.GEZEL_HOME;
    else process.env.GEZEL_HOME = previousHome;
    fs.rmSync(gezelHome, { recursive: true, force: true });
  }
});
