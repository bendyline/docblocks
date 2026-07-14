import fs from 'node:fs';
import path from 'node:path';
import { FUSE_STATE, readFuseWires } from './packaged-artifact.js';
import { expect, test } from './packaged-fixtures.js';

const EXPECTED_FUSES = [
  FUSE_STATE.disabled, // RunAsNode
  FUSE_STATE.enabled, // EnableCookieEncryption
  FUSE_STATE.disabled, // EnableNodeOptionsEnvironmentVariable
  FUSE_STATE.disabled, // EnableNodeCliInspectArguments
  FUSE_STATE.enabled, // EnableEmbeddedAsarIntegrityValidation
  FUSE_STATE.enabled, // OnlyLoadAppFromAsar
  FUSE_STATE.disabled, // LoadBrowserProcessSpecificV8Snapshot (no custom snapshot is packaged)
  FUSE_STATE.disabled, // GrantFileProtocolExtraPrivileges
] as const;

test('boots the packaged app.asar with production fuses and renderer isolation', async ({
  launchPackagedApp,
  workspaceDir,
}) => {
  const packaged = await launchPackagedApp();
  expect(fs.statSync(packaged.artifact.appAsarPath).isFile()).toBe(true);
  expect(path.basename(packaged.artifact.appAsarPath)).toBe('app.asar');

  const fuseWires = readFuseWires(packaged.artifact.fuseBinaryPath);
  expect(fuseWires.length).toBeGreaterThan(0);
  for (const wire of fuseWires) {
    expect(wire.version).toBe(1);
    expect(wire.states.slice(0, EXPECTED_FUSES.length)).toEqual(EXPECTED_FUSES);
  }

  await packaged.window.waitForSelector('.db-shell', { timeout: 30_000 });
  await expect(packaged.window.locator('.db-shell')).toBeVisible();
  expect(packaged.window.url()).toMatch(/^app:\/\/docblocks\/index\.html/u);

  const isolation = await packaged.window.evaluate(() => ({
    hasCommonJsRequire: typeof Reflect.get(window, 'require') === 'function',
    hasNodeProcess: typeof Reflect.get(window, 'process') === 'object',
    hasHostBridge: typeof Reflect.get(window, 'docBlocksHost') === 'object',
  }));
  expect(isolation).toEqual({
    hasCommonJsRequire: false,
    hasNodeProcess: false,
    hasHostBridge: true,
  });

  await expect(packaged.window.getByText('Welcome to DocBlocks')).toBeVisible({
    timeout: 15_000,
  });
  expect(fs.existsSync(path.join(workspaceDir, 'aboutDocBlocks.md'))).toBe(true);
});
