/** Privileged operations for exact OS-opened files, addressed only by grants. */

import { ipcMain } from 'electron';
import type { WebContents } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileCommitResult } from '@bendyline/docblocks/filesystem';
import {
  HOST_WIRE_LIMITS,
  isBoundedBytePayload,
  isBoundedString,
  type ExternalBinaryCommitResult,
} from '@bendyline/docblocks/host';

import {
  resolveExternalResource,
  revokeExternalOwner,
  revokeExternalResource,
} from './external-files.js';
import { assertIpcArgumentCount, assertTrustedIpcSender } from './ipc-authority.js';
import { bindOwnerGrantRevocation } from './owner-revocation.js';
import {
  atomicWriteBinary,
  atomicWriteText,
  commitBinaryFile,
  commitTextFile,
  withFileMutationLocks,
} from './file-commit.js';

const boundOwners = new WeakSet<WebContents>();

function ownerFor(event: Electron.IpcMainInvokeEvent): WebContents {
  const owner = assertTrustedIpcSender(event);
  if (!boundOwners.has(owner)) {
    boundOwners.add(owner);
    const ownerId = owner.id;
    bindOwnerGrantRevocation(owner, () => revokeExternalOwner(ownerId));
  }
  return owner;
}

function requireResourceId(value: unknown): string {
  if (!isBoundedString(value, HOST_WIRE_LIMITS.identifierCharacters, 1)) {
    throw new Error('Invalid external resource grant');
  }
  return value;
}

function requireText(value: unknown, label: string): string {
  if (!isBoundedString(value, HOST_WIRE_LIMITS.documentCharacters)) {
    throw new Error(`${label} exceeds the host document limit`);
  }
  return value;
}

function requireExpectedText(value: unknown): string | null {
  if (value === null) return null;
  return requireText(value, 'Expected content');
}

function requireExpectedVersion(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error('Invalid external file version');
  }
  return value.toLowerCase();
}

async function readBoundedFile(absolutePath: string, maximumBytes: number): Promise<Buffer | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(absolutePath, 'r');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximumBytes) {
      throw new Error('External file exceeds the host transfer limit');
    }
    await assertDescriptorStillNamesGrantedFile(absolutePath, stat);
    const result = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < result.length) {
      const { bytesRead } = await handle.read(result, offset, result.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    const { bytesRead: extraBytes } = await handle.read(extra, 0, 1, offset);
    if (extraBytes > 0) throw new Error('External file changed beyond the host transfer limit');
    const after = await handle.stat();
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) {
      throw new Error('External file changed while it was being read');
    }
    await assertDescriptorStillNamesGrantedFile(absolutePath, after);
    return result.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function assertDescriptorStillNamesGrantedFile(
  absolutePath: string,
  descriptorStat: Awaited<ReturnType<fs.FileHandle['stat']>>,
): Promise<void> {
  const lexical = path.resolve(absolutePath);
  const [linkStat, physicalPath, pathStat] = await Promise.all([
    fs.lstat(lexical),
    fs.realpath(lexical),
    fs.stat(lexical),
  ]);
  const normalize = (value: string) =>
    process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (
    linkStat.isSymbolicLink() ||
    normalize(physicalPath) !== normalize(lexical) ||
    descriptorStat.dev !== pathStat.dev ||
    descriptorStat.ino !== pathStat.ino
  ) {
    throw new Error('External resource changed physical identity while it was being read');
  }
}

export function registerExternalIpc(): void {
  ipcMain.handle('external:readText', async (event, ...args: unknown[]) => {
    const owner = ownerFor(event);
    assertIpcArgumentCount(args, 1);
    const [resourceValue] = args;
    const resourceId = requireResourceId(resourceValue);
    const absolutePath = await resolveExternalResource(owner.id, resourceId);
    const bytes = await readBoundedFile(absolutePath, HOST_WIRE_LIMITS.documentCharacters);
    if (!bytes) return null;
    const content = bytes.toString('utf8');
    return requireText(content, 'External document');
  });

  ipcMain.handle('external:readBinary', async (event, ...args: unknown[]) => {
    const owner = ownerFor(event);
    assertIpcArgumentCount(args, 1);
    const [resourceValue] = args;
    const resourceId = requireResourceId(resourceValue);
    const absolutePath = await resolveExternalResource(owner.id, resourceId);
    const bytes = await readBoundedFile(absolutePath, HOST_WIRE_LIMITS.binaryBytes);
    if (!bytes) return null;
    const result = new Uint8Array(bytes.byteLength);
    result.set(bytes);
    return result.buffer;
  });

  ipcMain.handle('external:writeText', async (event, ...args: unknown[]): Promise<void> => {
    const owner = ownerFor(event);
    assertIpcArgumentCount(args, 2);
    const [resourceValue, contentValue] = args;
    const resourceId = requireResourceId(resourceValue);
    const content = requireText(contentValue, 'External document');
    const absolutePath = await resolveExternalResource(owner.id, resourceId);
    await withFileMutationLocks([absolutePath], () => atomicWriteText(absolutePath, content));
  });

  ipcMain.handle('external:writeBinary', async (event, ...args: unknown[]): Promise<void> => {
    const owner = ownerFor(event);
    assertIpcArgumentCount(args, 2);
    const [resourceValue, dataValue] = args;
    const resourceId = requireResourceId(resourceValue);
    if (!isBoundedBytePayload(dataValue)) throw new Error('External binary exceeds host limits');
    const absolutePath = await resolveExternalResource(owner.id, resourceId);
    await withFileMutationLocks([absolutePath], () => atomicWriteBinary(absolutePath, dataValue));
  });

  ipcMain.handle(
    'external:commitText',
    async (event, ...args: unknown[]): Promise<FileCommitResult> => {
      const owner = ownerFor(event);
      assertIpcArgumentCount(args, 3);
      const [resourceValue, contentValue, expectedValue] = args;
      const resourceId = requireResourceId(resourceValue);
      const content = requireText(contentValue, 'External document');
      const expectedContent = requireExpectedText(expectedValue);
      const absolutePath = await resolveExternalResource(owner.id, resourceId);
      return commitTextFile(absolutePath, content, expectedContent);
    },
  );

  ipcMain.handle(
    'external:commitBinary',
    async (event, ...args: unknown[]): Promise<ExternalBinaryCommitResult> => {
      const owner = ownerFor(event);
      assertIpcArgumentCount(args, 3);
      const [resourceValue, dataValue, expectedValue] = args;
      const resourceId = requireResourceId(resourceValue);
      if (!isBoundedBytePayload(dataValue)) throw new Error('External binary exceeds host limits');
      const expectedVersion = requireExpectedVersion(expectedValue);
      const absolutePath = await resolveExternalResource(owner.id, resourceId);
      return commitBinaryFile(absolutePath, dataValue, expectedVersion);
    },
  );

  ipcMain.handle('external:revoke', async (event, ...args: unknown[]): Promise<void> => {
    const owner = ownerFor(event);
    assertIpcArgumentCount(args, 1);
    const [resourceValue] = args;
    revokeExternalResource(owner.id, requireResourceId(resourceValue));
  });
}
