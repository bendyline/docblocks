import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { DocBlocksHostAPI, HostFileSystemV2Result } from '@bendyline/docblocks/host';
import type { WorkspacePath } from '@bendyline/docblocks/filesystem';
import { test, expect } from './fixtures.js';

test('downloads a playable take and its slide timings from the recording review', async ({
  launchApp,
  workspaceDir,
}) => {
  fs.writeFileSync(
    path.join(workspaceDir, 'narration.md'),
    '# First slide\n\nRecording backup test.\n\n# Second slide\n\nThe end.\n',
  );
  const { window } = await launchApp([
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
  ]);
  await window.waitForSelector('.db-shell', { timeout: 30_000 });
  await window.setViewportSize({ width: 1800, height: 1100 });
  await window.locator('.db-tree-row').filter({ hasText: 'narration' }).click();
  await window.getByRole('tab', { name: 'Source', exact: true }).click();
  const insert = window.getByRole('button', { name: 'Insert', exact: true });
  if (!(await insert.isVisible())) {
    await window
      .getByRole('toolbar', { name: 'Formatting toolbar' })
      .getByRole('button', { name: 'More actions', exact: true })
      .click();
  }
  await window
    .getByRole('button', { name: /^Insert(?:\.\.\.)?$/ })
    .filter({ visible: true })
    .click();
  await window.getByRole('menuitem', { name: 'Document narration', exact: true }).click();
  const dialog = window.getByRole('dialog', { name: 'Record document narration' });
  await expect(dialog.getByText(/Automatically stops at 900.0 MiB total/)).toBeVisible();
  const camera = dialog.getByRole('button', { name: 'Camera', exact: true });
  if ((await camera.getAttribute('aria-pressed')) !== 'true') await camera.click();
  await dialog.getByRole('checkbox', { name: 'Show slides mode' }).check();
  await dialog.getByRole('button', { name: 'Start preview', exact: true }).click();
  await dialog.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await expect(dialog.getByText(/Recording 0:0[1-9]/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Stop', exact: true }).click();
  const media = dialog.getByRole('link', { name: 'Download recording', exact: true });
  const timing = dialog.getByRole('link', { name: 'Download recording timings', exact: true });
  await expect(media).toBeVisible();
  await expect(timing).toBeVisible();
  const cdp = await window.context().newCDPSession(window);
  await cdp.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: workspaceDir,
    eventsEnabled: true,
  });
  for (const link of [media, timing]) {
    const name = await link.getAttribute('download');
    if (!name || path.basename(name) !== name) throw new Error('Invalid backup filename');
    const expectedHash = await link.evaluate(async (element) => {
      const bytes = await (await fetch((element as HTMLAnchorElement).href)).arrayBuffer();
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
    });
    await link.click();
    const destination = path.join(workspaceDir, name);
    await expect
      .poll(() =>
        fs.existsSync(destination)
          ? createHash('sha256').update(fs.readFileSync(destination)).digest('hex')
          : '',
      )
      .toBe(expectedHash);
    expect(fs.statSync(destination).size).toBeGreaterThan(0);
  }
  await dialog.locator('video[controls]').evaluate(async (video: HTMLVideoElement) => {
    video.muted = true;
    await video.play();
  });
  await expect
    .poll(() =>
      dialog.locator('video[controls]').evaluate((video: HTMLVideoElement) => video.currentTime),
    )
    .toBeGreaterThan(0);
});

test('saves and reopens a recording above the old 100 MiB IPC limit', async ({
  launchApp,
  workspaceDir,
}) => {
  const { window } = await launchApp();
  await window.waitForSelector('.db-shell', { timeout: 30_000 });
  const result = await window.evaluate(async () => {
    const host = (globalThis as unknown as { docBlocksHost: DocBlocksHostAPI }).docBlocksHost;
    const api = host.fsV2;
    if (
      !api?.beginWrite ||
      !api.writeChunk ||
      !api.finishWrite ||
      !api.beginRead ||
      !api.readChunk ||
      !api.closeTransfer
    )
      throw new Error('Missing transfer API');
    const unwrap = <T>(result: HostFileSystemV2Result<T>): T => {
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    };
    const workspace = await host.workspaces.getDefault();
    const instance = 'large-recording-e2e';
    const file = 'recording.webm' as WorkspacePath;
    const size = 128 * 1024 * 1024 + 3;
    const chunkBytes = 4 * 1024 * 1024;
    unwrap(await api.open({ instanceId: instance, providerId: workspace.id, label: 'Recording' }));
    try {
      const upload = unwrap(await api.beginWrite(instance, file, size, { mode: 'create' }));
      for (let offset = 0; offset < size; offset += chunkBytes) {
        const bytes = new Uint8Array(Math.min(chunkBytes, size - offset)).fill(offset / chunkBytes);
        unwrap(await api.writeChunk(instance, upload, offset, bytes));
      }
      const saved = unwrap(await api.finishWrite(instance, upload));
      unwrap(await api.closeTransfer(instance, upload));
      const download = unwrap(await api.beginRead(instance, file));
      if (!download) throw new Error('Saved recording is missing');
      let total = 0;
      try {
        while (total < size) {
          const bytes = new Uint8Array(
            unwrap(await api.readChunk(instance, download.transferId, total)),
          );
          if (
            bytes.length !== Math.min(chunkBytes, size - total) ||
            !bytes.every((byte) => byte === total / chunkBytes)
          )
            throw new Error('Recording bytes changed during transfer');
          total += bytes.length;
        }
      } finally {
        unwrap(await api.closeTransfer(instance, download.transferId));
      }
      return { size: saved.size, total, sameVersion: saved.version === download.entry.version };
    } finally {
      unwrap(await api.dispose(instance));
    }
  });
  expect(result).toEqual({
    size: 128 * 1024 * 1024 + 3,
    total: 128 * 1024 * 1024 + 3,
    sameVersion: true,
  });
  expect(fs.statSync(path.join(workspaceDir, 'recording.webm')).size).toBe(result.size);
});
