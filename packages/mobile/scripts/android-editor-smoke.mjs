/* global window, document */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import process from 'node:process';
import { _android, expect } from '@playwright/test';
const serial = process.argv[2];
if (!serial) throw new Error('Supply an explicit Android device ID.');
const offline = process.argv.includes('--offline');
if (offline && !/^emulator-\d+$/.test(serial))
  throw new Error('The offline test changes connectivity and requires an emulator.');
const app = 'com.bendyline.docblocks.mobile.tests';
const device = (await _android.devices()).find((item) => item.serial() === serial);
if (!device) throw new Error('The requested Android device is unavailable.');
const root = fileURLToPath(new URL('../../../', import.meta.url));
mkdirSync(path.join(root, 'reports/mobile-native'), { recursive: true });
const errors = [];
let page;
let previousAirplaneMode;
let previousWifiEnabled;
const capture = (target) => {
  target.on('pageerror', (error) => errors.push(error.message));
  target.on('console', (message) => {
    if (message.type() === 'error') errors.push(`${message.text()} (${message.location().url})`);
  });
  target.setDefaultTimeout(20000);
};
const attach = async () => {
  const view = await device.webView({ pkg: app });
  const target = await view.page();
  capture(target);
  return target;
};
try {
  if (offline) {
    previousAirplaneMode = (await device.shell('cmd connectivity airplane-mode')).toString().trim();
    assert.ok(['enabled', 'disabled'].includes(previousAirplaneMode));
    previousWifiEnabled = (await device.shell('cmd wifi status'))
      .toString()
      .startsWith('Wifi is enabled');
    await device.shell('cmd connectivity airplane-mode enable');
    await device.shell('svc wifi disable');
    // Android WebView's navigator.onLine stays true without network-state
    // permission. Check the OS route instead of adding a production permission.
    await expect
      .poll(
        async () =>
          (await device.shell('dumpsys connectivity'))
            .toString()
            .match(/^Active default network: .+$/m)?.[0],
        { timeout: 20000 },
      )
      .toBe('Active default network: none');
    await device.shell(`am force-stop ${app}`);
  }
  await device.shell(`am start -n ${app}/com.bendyline.docblocks.mobile.MainActivity`);
  page = await attach();
  await page.locator('.db-shell').waitFor();
  const name = `mobile-smoke-${randomUUID()}.md`;
  if (await page.getByRole('button', { name: 'Create a document', exact: true }).isVisible()) {
    await page.getByRole('button', { name: 'Create a document', exact: true }).click();
    await page.getByRole('textbox', { name: 'Document name', exact: true }).fill(name);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'New document' })).toBeHidden();
  } else {
    if ((await page.locator('.db-shell-sidebar').getAttribute('inert')) !== null)
      await page.getByRole('button', { name: 'Show file list', exact: true }).click();
    if (!(await page.getByRole('textbox', { name: 'New file name', exact: true }).isVisible()))
      await page.getByRole('button', { name: 'New File', exact: true }).click();
    await page.getByRole('textbox', { name: 'New file name', exact: true }).fill(name);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
  }
  await expect(page.locator('.db-shell-editor-area')).not.toHaveAttribute('inert');
  const text = `Native Android persistence ${randomUUID()}`;
  const editor = page.locator('.tiptap[contenteditable=true]');
  await editor.fill(text);
  await expect
    .poll(
      async () => (await device.shell(`run-as ${app} cat files/Workspace/${name}`)).toString(),
      { timeout: 20000 },
    )
    .toContain(text);
  // Kill/relaunch only the isolated test app, after the native write is acknowledged.
  await device.shell(`am force-stop ${app}`);
  await device.shell(`am start -n ${app}/com.bendyline.docblocks.mobile.MainActivity`);
  page = await attach();
  await expect(page.locator('.tiptap')).toContainText(text, { timeout: 30000 });
  await page.getByRole('tab', { name: 'Source', exact: true }).click();
  await expect(page.locator('.monaco-editor').first()).toBeVisible();
  await page.getByRole('tab', { name: 'Write', exact: true }).click();
  // A same-origin child frame must not receive native authority.
  await page.evaluate(() => {
    window.__nativeProbe = [];
    window.__originalFromNative = window.Capacitor.fromNative;
    window.Capacitor.fromNative = (value) => {
      if (value.callbackId === 'iframe-probe') window.__nativeProbe.push(value);
      window.__originalFromNative(value);
    };
    const frame = document.createElement('iframe');
    frame.id = 'native-probe';
    frame.src = 'about:blank';
    document.body.append(frame);
  });
  const frame = page.frameLocator('#native-probe');
  await frame.locator('body').evaluate(() => {
    globalThis.androidBridge?.postMessage(
      JSON.stringify({
        callbackId: 'iframe-probe',
        pluginId: 'DocBlocksMobile',
        methodName: 'bootstrap',
        options: {},
      }),
    );
  });
  await delay(300);
  assert.equal(
    await page.evaluate(() => window.__nativeProbe.length),
    0,
    'Child frame received native authority',
  );
  await page.evaluate(() => {
    window.Capacitor.fromNative = window.__originalFromNative;
    document.getElementById('native-probe').remove();
    delete window.__nativeProbe;
    delete window.__originalFromNative;
  });
  await page.screenshot({ path: path.join(root, 'reports/mobile-native/android-editor.png') });
  assert.deepEqual(errors, [], 'Unexpected Android WebView errors');
  process.stdout.write(
    `Android ${offline ? 'offline ' : ''}editor create/edit/native save/process restart/source worker/bridge isolation passed.\n`,
  );
} finally {
  try {
    if (['enabled', 'disabled'].includes(previousAirplaneMode))
      await device.shell(
        `cmd connectivity airplane-mode ${previousAirplaneMode === 'enabled' ? 'enable' : 'disable'}`,
      );
    if (previousWifiEnabled !== undefined)
      await device.shell(`svc wifi ${previousWifiEnabled ? 'enable' : 'disable'}`);
  } finally {
    await device.close();
  }
}
