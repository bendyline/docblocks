/**
 * IPC handlers for reading/writing individual external files the user opened
 * from the OS (transient workspaces — loose markdown files and `.dbk` bundles).
 *
 * Every handler is gated on the session allowlist (external-files.ts): only a
 * path the user explicitly opened this session can be touched. This is the
 * single seam through which a transient workspace saves back to disk.
 */

import { ipcMain } from 'electron';
import fs from 'node:fs/promises';

import { isExternalPathAllowed } from './external-files.js';

function assertAllowed(p: string): void {
  if (!isExternalPathAllowed(p)) {
    throw new Error('External path is not permitted (not opened this session)');
  }
}

export function registerExternalIpc(): void {
  ipcMain.handle('external:readText', async (_e, p: string): Promise<string | null> => {
    assertAllowed(p);
    try {
      return await fs.readFile(p, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  });

  ipcMain.handle('external:readBinary', async (_e, p: string): Promise<ArrayBuffer | null> => {
    assertAllowed(p);
    try {
      const buf = await fs.readFile(p);
      const arr = new Uint8Array(buf.byteLength);
      arr.set(buf);
      return arr.buffer;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  });

  ipcMain.handle('external:writeText', async (_e, p: string, content: string): Promise<void> => {
    assertAllowed(p);
    await fs.writeFile(p, content, 'utf8');
  });

  ipcMain.handle(
    'external:writeBinary',
    async (_e, p: string, data: ArrayBuffer | Uint8Array): Promise<void> => {
      assertAllowed(p);
      const buf =
        data instanceof Uint8Array ? Buffer.from(data) : Buffer.from(new Uint8Array(data));
      await fs.writeFile(p, buf);
    },
  );
}
