import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';

/**
 * Stat a pathname through a fresh descriptor so it is comparable with fstat.
 * Node 22 on Windows reports a device id from fstat but zero from stat(path).
 */
export async function statFileThroughDescriptor(filePath: string): Promise<Stats> {
  const handle = await fs.open(filePath, 'r');
  try {
    return await handle.stat();
  } finally {
    await handle.close();
  }
}
