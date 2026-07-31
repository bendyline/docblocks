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
  for (const legalResource of [
    'THIRD_PARTY_NOTICES.txt',
    'licenses/ELECTRON_LICENSE.txt',
    'licenses/ELECTRON_THIRD_PARTY_NOTICES.html',
  ]) {
    expect(fs.statSync(path.join(packaged.artifact.resourcesPath, legalResource)).isFile()).toBe(
      true,
    );
  }

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

  await expect(packaged.window.locator('.db-welcome-gateway')).toBeVisible({
    timeout: 15_000,
  });
  const welcome = path.join(workspaceDir, 'aboutDocBlocks.md');
  await expect.poll(() => fs.existsSync(welcome), { timeout: 15_000 }).toBe(true);
  expect(fs.readFileSync(welcome, 'utf8')).toContain(
    '# DocBlocks: one Markdown file, many finished forms',
  );
});

test('grants capture only to the trusted renderer and exposes only working presentation targets', async ({
  launchPackagedApp,
}) => {
  const packaged = await launchPackagedApp(['--use-fake-device-for-media-stream']);
  await packaged.window.waitForSelector('.db-shell', { timeout: 30_000 });

  const grantedMedia = await packaged.window.evaluate(async () => {
    const request = async (constraints: MediaStreamConstraints) => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        const result = {
          status: 'granted' as const,
          audioTracks: stream.getAudioTracks().length,
          videoTracks: stream.getVideoTracks().length,
        };
        stream.getTracks().forEach((track) => track.stop());
        return result;
      } catch (error: unknown) {
        return {
          status: 'denied' as const,
          name: error instanceof DOMException ? error.name : 'Error',
        };
      }
    };
    return {
      microphone: await request({ audio: true, video: false }),
      camera: await request({ audio: false, video: true }),
    };
  });
  expect(grantedMedia).toEqual({
    microphone: { status: 'granted', audioTracks: 1, videoTracks: 0 },
    camera: { status: 'granted', audioTracks: 0, videoTracks: 1 },
  });

  // An automation-only exact popup route creates a genuine second
  // BrowserWindow/WebContents in the same Electron session. Its canonical
  // app:// URL is not enough to inherit the main window's media authority.
  const unownedPagePromise = packaged.context.waitForEvent('page');
  const popupOpened = await packaged.window.evaluate(
    () =>
      window.open(
        'app://docblocks/index.html?docblocks-e2e-permission-probe=1',
        'docblocks-e2e-permission-probe',
      ) !== null,
  );
  expect(popupOpened).toBe(true);
  const unownedPage = await unownedPagePromise;
  try {
    await unownedPage.waitForURL('app://docblocks/index.html?docblocks-e2e-permission-probe=1', {
      waitUntil: 'domcontentloaded',
    });
    const deniedMedia = await unownedPage.evaluate(async () => {
      const request = async (constraints: MediaStreamConstraints) => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia(constraints);
          stream.getTracks().forEach((track) => track.stop());
          return 'granted';
        } catch (error: unknown) {
          return error instanceof DOMException ? error.name : 'Error';
        }
      };
      return {
        microphone: await request({ audio: true, video: false }),
        camera: await request({ audio: false, video: true }),
      };
    });
    expect(deniedMedia).toEqual({
      microphone: 'NotAllowedError',
      camera: 'NotAllowedError',
    });
  } finally {
    await unownedPage.close();
  }

  // Exercise getDisplayMedia through a real click so the main process sees
  // Chromium's required transient user activation.
  // A headless macOS runner cannot operate the native screen picker or grant
  // TCC screen-recording consent. Windows exercises loopback audio too.
  if (process.platform !== 'darwin') {
    const requestSystemAudio = process.platform === 'win32';
    await packaged.window.evaluate((audio) => {
      const trigger = document.createElement('button');
      trigger.id = 'docblocks-e2e-display-capture';
      trigger.textContent = 'Capture display';
      trigger.style.position = 'fixed';
      trigger.style.top = '8px';
      trigger.style.left = '8px';
      trigger.style.zIndex = '2147483647';
      trigger.addEventListener('click', () => {
        void navigator.mediaDevices
          .getDisplayMedia({ video: true, audio })
          .then((stream) => {
            const result = {
              status: 'granted',
              audioTracks: stream.getAudioTracks().length,
              videoTracks: stream.getVideoTracks().length,
            };
            stream.getTracks().forEach((track) => track.stop());
            Reflect.set(globalThis, 'docBlocksE2eDisplayCapture', result);
          })
          .catch((error: unknown) => {
            Reflect.set(globalThis, 'docBlocksE2eDisplayCapture', {
              status: 'denied',
              name: error instanceof DOMException ? error.name : 'Error',
            });
          });
      });
      document.body.appendChild(trigger);
    }, requestSystemAudio);
    await packaged.window.locator('#docblocks-e2e-display-capture').click();
    await expect
      .poll(
        () => packaged.window.evaluate(() => Reflect.get(globalThis, 'docBlocksE2eDisplayCapture')),
        { timeout: 30_000 },
      )
      .toEqual({
        status: 'granted',
        audioTracks: requestSystemAudio ? 1 : 0,
        videoTracks: 1,
      });
  }

  const gateway = packaged.window.locator('.db-welcome-gateway');
  if (await gateway.isVisible()) {
    await packaged.window.locator('.db-welcome-gateway-cta').click();
  }
  await packaged.window.locator('[role="tab"][data-view="preview"]').click();
  const presentationOptions = packaged.window.getByRole('button', {
    name: 'Presentation options',
  });
  await expect(presentationOptions).toBeVisible({ timeout: 15_000 });

  await presentationOptions.click();
  const menu = packaged.window.getByRole('menu', { name: 'Presentation options' });
  await expect(menu.getByRole('menuitemradio', { name: /Fill canvas/ })).toBeVisible();
  await expect(menu.getByRole('menuitemradio', { name: /Full screen/ })).toBeVisible();
  await expect(menu.getByRole('menuitemradio', { name: /New window/ })).toHaveCount(0);

  await packaged.window.getByRole('button', { name: 'Present: Fill canvas' }).click();
  await expect(
    packaged.window.locator('.squisq-editor-shell[data-presentation-mode="control"]'),
  ).toBeVisible();
  await packaged.window.getByRole('button', { name: 'Exit presentation' }).click();

  // Electron turns HTML fullscreen into a native macOS Spaces transition. A
  // runner with no attached display session never completes that transition:
  // the renderer flips `document.fullscreenElement` within milliseconds, but
  // the window never actually enters fullscreen, so the exit stays queued
  // behind an enter that never lands and the element is never released. The
  // exit affordance itself is still covered on macOS by the Fill canvas leg
  // above, which needs no native transition.
  if (process.platform !== 'darwin') {
    await presentationOptions.click();
    await menu.getByRole('menuitemradio', { name: /Full screen/ }).click();
    await packaged.window.getByRole('button', { name: 'Present: Full screen' }).click();
    await expect
      .poll(() => packaged.window.evaluate(() => document.fullscreenElement !== null))
      .toBe(true);
    await expect(
      packaged.window.locator('.squisq-editor-shell[data-presentation-mode="fullscreen"]'),
    ).toBeVisible();
    await packaged.window.getByRole('button', { name: 'Exit presentation' }).click();
    await expect
      .poll(() => packaged.window.evaluate(() => document.fullscreenElement === null))
      .toBe(true);
  }
});
