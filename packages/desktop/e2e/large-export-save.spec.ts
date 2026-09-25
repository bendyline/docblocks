import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DocBlocksHostAPI } from '@bendyline/docblocks/host';
import { test, expect } from './fixtures.js';

const SIZE = 128 * 1024 * 1024 + 3;
const CHUNK_BYTES = 4 * 1024 * 1024;

// A long video export used to fail with "Export payload exceeds host limits":
// the whole file crossed as one IPC message capped at 100 MiB.
test('saves an export above the old 100 MiB IPC limit in chunks', async ({
  launchApp,
  userDataDir,
}) => {
  const exportDir = path.join(userDataDir, 'exports');
  const target = path.join(exportDir, 'talk.mp4');
  fs.mkdirSync(exportDir);
  // A remembered picker choice is the grant a native Save dialog would mint,
  // without a dialog the test cannot answer.
  const documentId = JSON.stringify(['e2e-workspace', '/talk.md']);
  const documentKey = createHash('sha256').update(documentId).digest('hex');
  const access = { path: target, confirmedByPicker: true };
  fs.writeFileSync(
    path.join(userDataDir, 'settings.json'),
    JSON.stringify({
      workspaces: [],
      exportTargets: { [documentKey]: { last: access, byExtension: { mp4: access } } },
    }),
  );

  const { window } = await launchApp();
  await window.waitForSelector('.db-shell', { timeout: 30_000 });
  const saved = await window.evaluate(
    async ({ documentId, size, chunkBytes }) => {
      const host = (globalThis as unknown as { docBlocksHost: DocBlocksHostAPI }).docBlocksHost;
      const api = host.exports;
      if (!api?.beginSave || !api.writeChunk || !api.finishSave || !api.closeTransfer) {
        throw new Error('Missing chunked export API');
      }
      const granted = await api.resolveTarget(documentId, 'talk.mp4');
      if (!granted.grantId) throw new Error('The remembered export target was not granted');
      const transferId = await api.beginSave(documentId, 'talk.mp4', granted.grantId, size);
      try {
        for (let offset = 0; offset < size; offset += chunkBytes) {
          const bytes = new Uint8Array(Math.min(chunkBytes, size - offset)).fill(
            offset / chunkBytes,
          );
          await api.writeChunk(transferId, offset, bytes);
        }
        return await api.finishSave(transferId);
      } finally {
        await api.closeTransfer(transferId);
      }
    },
    { documentId, size: SIZE, chunkBytes: CHUNK_BYTES },
  );

  expect(saved?.grantId).toBeTruthy();
  expect(fs.readdirSync(exportDir)).toEqual(['talk.mp4']);
  expect(fs.statSync(target).size).toBe(SIZE);
  const handle = fs.openSync(target, 'r');
  try {
    const chunk = Buffer.alloc(CHUNK_BYTES);
    for (let offset = 0; offset < SIZE; offset += CHUNK_BYTES) {
      const length = fs.readSync(handle, chunk, 0, Math.min(CHUNK_BYTES, SIZE - offset), offset);
      const expected = offset / CHUNK_BYTES;
      expect(chunk.subarray(0, length).every((byte) => byte === expected)).toBe(true);
    }
  } finally {
    fs.closeSync(handle);
  }
});
