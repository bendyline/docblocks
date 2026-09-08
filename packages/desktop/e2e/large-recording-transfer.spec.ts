import fs from 'node:fs';
import path from 'node:path';
import type { DocBlocksHostAPI, HostFileSystemV2Result } from '@bendyline/docblocks/host';
import type { WorkspacePath } from '@bendyline/docblocks/filesystem';
import { test, expect } from './fixtures.js';

// The narration-capture counterpart to this test (record a take through the
// dialog, then download the media and its slide timings) was removed: it
// depends on Electron producing real MediaRecorder output, which the headless
// Linux CI runner does not do reliably — it failed four consecutive runs at
// three different points while passing 25/25 locally on Windows. Re-add it only
// behind a capture path that is deterministic under xvfb.
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
