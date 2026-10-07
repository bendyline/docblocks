/* global window */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import { _android, expect } from '@playwright/test';
const serial = process.argv[2];
const downloadModel = process.argv.includes('--download');
const realModel = downloadModel || process.argv.includes('--installed');
if (!serial) throw new Error('Supply an explicit arm64 Android test device ID.');
const device = (await _android.devices()).find((item) => item.serial() === serial);
if (!device) throw new Error('The requested Android device is unavailable.');
const app = 'com.bendyline.docblocks.mobile.tests';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const errors = [];
let page;
let saved;
try {
  assert.match((await device.shell('getprop ro.product.cpu.abilist')).toString(), /arm64-v8a/);
  const native = (
    await device.shell(
      `am instrument -w -e class com.bendyline.docblocks.mobile.MobileAiFixtureTest ${app}.test/androidx.test.runner.AndroidJUnitRunner`,
    )
  ).toString();
  assert.match(native, /OK \(2 tests\)/, native);
  await device.shell(`am start -n ${app}/com.bendyline.docblocks.mobile.MainActivity`);
  page = await (await device.webView({ pkg: app }, { timeout: 90_000 })).page();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.locator('.db-shell').waitFor();
  saved = await page.evaluate(() => window.docBlocksHost.ai.getPreferences());
  await page.evaluate(() => window.docBlocksHost.ai.setPreferences({ enabled: false }));
  await page.locator('.db-shell[data-db-layout]').waitFor();
  // Restoring the last document can open the editor while initial layout settles.
  await expect(async () => {
    if (await page.getByRole('button', { name: 'Show file list', exact: true }).isVisible())
      await page.getByRole('button', { name: 'Show file list', exact: true }).click();
    await page.locator('.db-app-menu-btn').click({ timeout: 1500 });
  }).toPass({ timeout: 15_000 });
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  const toggle = page.getByRole('checkbox', { name: 'Use AI features' });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(page.getByRole('button', { name: 'Add model…' })).toBeVisible();
  const system = await page.evaluate(async () => {
    const result = await window.docBlocksHost.ai.models();
    if (!result.ok) throw new Error(result.error.message);
    return result.value.find((model) => model.id === 'android-mlkit:android-mlkit');
  });
  assert.ok(system, 'ML Kit must remain discoverable even on unsupported devices.');
  const systemOption = page
    .getByRole('combobox', { name: 'Model', exact: true })
    .locator('option[value="android-mlkit:android-mlkit"]');
  await expect(systemOption).toHaveText(/Gemini Nano \(Android ML Kit\)/);
  await expect(systemOption).toHaveJSProperty('disabled', system.availability !== 'available');
  if (system.availability !== 'available') {
    await expect(
      page.getByText(`Gemini Nano (Android ML Kit): ${system.unavailableReason}`, { exact: true }),
    ).toBeVisible();
  }
  await page.getByRole('button', { name: 'Add model…' }).click();
  await expect(page.getByLabel('Model to download')).toBeVisible();
  if (downloadModel) {
    await page.getByRole('button', { name: 'Download model', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Download model', exact: true })).toBeEnabled({
      timeout: 600_000,
    });
    await expect(page.getByRole('alert')).toHaveCount(0);
  }
  const reply = await page.evaluate(
    async ({ realModel, downloadModel }) => {
      const ai = window.docBlocksHost.ai;
      const models = await ai.models();
      if (!models.ok) throw new Error(models.error.message);
      const inventory = await window.Capacitor.nativePromise('GezelRuntime', 'listModels', {});
      const preferred = await ai.getPreferences();
      if (realModel && !downloadModel)
        preferred.model = models.value.find((item) => item.label.startsWith('Qwen 3.5'))?.id;
      const model = models.value.find(
        (item) =>
          item.id === (realModel ? preferred.model : `llama-cpp:${inventory.selectedModelId}`),
      );
      if (!model) throw new Error('Missing isolated synthetic model.');
      await ai.setPreferences({ model: model.id });
      const events = [];
      const result = await ai.chat(
        {
          purpose: 'write',
          maxTokens: realModel ? 512 : 8,
          messages: [
            {
              role: 'user',
              content: realModel
                ? 'Rewrite this sentence concisely. Return only the rewritten sentence: We are writing to let you know that the meeting that was previously scheduled for Monday will now take place on Tuesday.'
                : 'Hello',
            },
          ],
        },
        (event) => events.push(event),
      ).done;
      return { result, events };
    },
    { realModel, downloadModel },
  );
  assert.ok(reply.result.ok, JSON.stringify(reply));
  if (realModel) {
    assert.ok(reply.result.value.text.trim().length > 10);
    assert.doesNotMatch(reply.result.value.text, /<\/?think>/);
    process.stdout.write(`On-device rewrite: ${reply.result.value.text}\n`);
  } else assert.match(reply.result.value.text, /^a+$/);
  assert.equal(reply.events.filter((event) => event.kind !== 'delta').length, 1);
  mkdirSync(path.join(root, 'reports/mobile-native'), { recursive: true });
  await toggle.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(root, 'reports/mobile-native/android-ai-settings.png') });
  assert.deepEqual(errors, []);
  process.stdout.write(
    'Android native fixture, Settings opt-in/catalog, and host.ai → App SDK → bundled engine streaming passed.\n',
  );
} finally {
  if (page && saved)
    await page.evaluate(
      (preferences) => window.docBlocksHost.ai.setPreferences(preferences),
      saved,
    );
  await device.close();
}
