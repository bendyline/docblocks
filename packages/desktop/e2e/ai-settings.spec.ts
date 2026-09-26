/**
 * AI through the whole desktop stack: Settings UI → preload → IPC → main →
 * the Gezel app SDK loaded by dynamic import → runtime discovery.
 *
 * `GEZEL_HOME` points at an empty directory, so discovery deterministically
 * finds no Gezel whatever is installed on the machine running the suite.
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
          ai?: { status(): Promise<unknown>; getPreferences(): Promise<unknown> };
        };
      }
    ).docBlocksHost?.ai;
    if (!ai) throw new Error('The desktop host exposes no AI namespace');
    return { status: await ai.status(), preferences: await ai.getPreferences() };
  });
}

async function openAiSettings(window: Page) {
  await window.locator('.db-app-menu-btn').click();
  await window.getByRole('menuitem', { name: 'Settings' }).click();
  const dialog = window.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  return dialog.getByRole('group', { name: 'AI assistance' });
}

test('AI is off until opted in, then reports a missing Gezel and remembers the choice', async ({
  launchApp,
}) => {
  const gezelHome = fs.mkdtempSync(path.join(os.tmpdir(), 'docblocks-e2e-gezel-home-'));
  const previousHome = process.env.GEZEL_HOME;
  // A developer pointing DocBlocks at a Gezel service checkout would let this
  // source build host one, and "not installed" would never be reported.
  const previousServiceEntry = process.env.DOCBLOCKS_GEZEL_SERVICE_ENTRY;
  process.env.GEZEL_HOME = gezelHome;
  delete process.env.DOCBLOCKS_GEZEL_SERVICE_ENTRY;
  try {
    const first = await launchApp();
    await first.window.waitForSelector('.db-shell', { timeout: 30_000 });
    expect(await readAi(first.window)).toEqual({
      status: { kind: 'unavailable', reason: 'opt-out' },
      preferences: { enabled: false, model: null, reviewMode: 'explicit' },
    });

    const section = await openAiSettings(first.window);
    const optIn = section.getByRole('checkbox', { name: 'Use Gezel for AI features' });
    await expect(optIn).not.toBeChecked();
    await optIn.check();
    await expect(section.getByRole('status')).toHaveText(
      'Gezel is not installed on this computer. Install Gezel, then choose Connect.',
    );
    await expect(section.getByRole('button', { name: 'Connect' })).toBeEnabled();
    await expect(section.getByRole('alert')).toHaveCount(0);
    await first.close();

    // The opt-in persists; relaunching looks for Gezel again, silently.
    const second = await launchApp();
    await second.window.waitForSelector('.db-shell', { timeout: 30_000 });
    await expect
      .poll(async () => (await readAi(second.window)).status, { timeout: 15_000 })
      .toEqual({ kind: 'unavailable', reason: 'not-installed' });
    expect((await readAi(second.window)).preferences).toEqual({
      enabled: true,
      model: null,
      reviewMode: 'explicit',
    });
  } finally {
    if (previousHome === undefined) delete process.env.GEZEL_HOME;
    else process.env.GEZEL_HOME = previousHome;
    if (previousServiceEntry !== undefined) {
      process.env.DOCBLOCKS_GEZEL_SERVICE_ENTRY = previousServiceEntry;
    }
    fs.rmSync(gezelHome, { recursive: true, force: true });
  }
});
