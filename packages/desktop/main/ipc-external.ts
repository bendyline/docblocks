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
import type { FileCommitResult } from '@bendyline/docblocks/filesystem';
import type { ExternalBinaryCommitResult } from '@bendyline/docblocks/host';

import { isExternalPathAllowed } from './external-files.js';
import {
  atomicWriteBinary,
  atomicWriteText,
  commitBinaryFile,
  commitTextFile,
  withFileMutationLocks,
} from './file-commit.js';

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
    await withFileMutationLocks([p], () => atomicWriteText(p, content));
  });

  ipcMain.handle(
    'external:writeBinary',
    async (_e, p: string, data: ArrayBuffer | Uint8Array): Promise<void> => {
      assertAllowed(p);
      await withFileMutationLocks([p], () => atomicWriteBinary(p, data));
    },
  );

  ipcMain.handle(
    'external:commitText',
    async (
      _e,
      p: string,
      content: string,
      expectedContent: string | null,
    ): Promise<FileCommitResult> => {
      assertAllowed(p);
      return commitTextFile(p, content, expectedContent);
    },
  );

  ipcMain.handle(
    'external:commitBinary',
    async (
      _e,
      p: string,
      data: ArrayBuffer | Uint8Array,
      expectedVersion: string | null,
    ): Promise<ExternalBinaryCommitResult> => {
      assertAllowed(p);
      return commitBinaryFile(p, data, expectedVersion);
    },
  );
}
