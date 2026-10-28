/**
 * The opt-in tray icon through the whole desktop stack: Settings UI → preload
 * → IPC → main → settings.json, and back on the next launch. The native icon
 * itself is not observable from Playwright; tray-menu-template.test.ts covers
 * what its menu offers.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';

import { test, expect } from './fixtures.js';

const PLACE: Record<string, { legend: string; label: string }> = {
  darwin: { legend: 'Menu bar', label: 'Show DocBlocks in the menu bar' },
  win32: { legend: 'Notification area', label: 'Show DocBlocks in the notification area' },
  linux: { legend: 'System tray', label: 'Show DocBlocks in the system tray' },
};
const place = PLACE[process.platform] ?? PLACE.linux;

async function readTrayEnabled(window: Page): Promise<boolean> {
  return window.evaluate(async () => {
    const menu = (
      globalThis as { docBlocksHost?: { menu?: { getTrayEnabled?(): Promise<boolean> } } }
    ).docBlocksHost?.menu;
    if (!menu?.getTrayEnabled) throw new Error('The desktop host exposes no tray switch');
    return menu.getTrayEnabled();
  });
}

function persistedTray(userDataDir: string): unknown {
  try {
    const settings = JSON.parse(
      fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf8'),
    ) as { tray?: unknown };
    return settings.tray;
  } catch {
    return undefined;
  }
}

async function openTraySettings(window: Page) {
  await window.locator('.db-app-menu-btn').click();
  await window.getByRole('menuitem', { name: 'Settings' }).click();
  const dialog = window.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('tab', { name: 'Device integration', exact: true }).click();
  return dialog.getByRole('group', { name: place.legend });
}

test('the tray icon is off until turned on, and the choice persists', async ({
  launchApp,
  userDataDir,
}) => {
  const first = await launchApp();
  await first.window.waitForSelector('.db-shell', { timeout: 30_000 });
  expect(await readTrayEnabled(first.window)).toBe(false);

  const section = await openTraySettings(first.window);
  const toggle = section.getByRole('checkbox', { name: place.label });
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(toggle).toBeChecked();
  expect(await readTrayEnabled(first.window)).toBe(true);
  await expect.poll(() => persistedTray(userDataDir)).toEqual({ enabled: true });
  await first.close();

  const second = await launchApp();
  await second.window.waitForSelector('.db-shell', { timeout: 30_000 });
  expect(await readTrayEnabled(second.window)).toBe(true);
  const reopened = await openTraySettings(second.window);
  const toggleAgain = reopened.getByRole('checkbox', { name: place.label });
  await expect(toggleAgain).toBeChecked();
  await toggleAgain.uncheck();
  await expect.poll(() => persistedTray(userDataDir)).toEqual({ enabled: false });
  expect(await readTrayEnabled(second.window)).toBe(false);
  await second.close();
});
