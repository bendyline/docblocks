import { randomUUID } from 'node:crypto';
import fs, { type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  FsError,
  type FileSystemFileSnapshot,
  type FileSystemWriteOptions,
  type WorkspacePath,
} from '@bendyline/docblocks/filesystem';
import {
  FILE_SYSTEM_TRANSFER_LIMITS as LIMITS,
  isBoundedBytePayload,
} from '@bendyline/docblocks/host';
import type { NodeWorkspaceFileSystemV2 } from './node-workspace-filesystem-v2.js';

interface Transfer {
  id: string;
  owner: string;
  instance: string;
  kind: 'read' | 'write';
  path: WorkspacePath;
  options: FileSystemWriteOptions;
  directory: string;
  file: string;
  handle: FileHandle;
  reserved: number;
  size: number;
  offset: number;
  deadline: number;
  revoked: boolean;
  pending: Promise<unknown> | null;
  closing: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Owner-scoped, expiring disk spools. No incomplete upload touches a workspace. */
export class FileSystemTransfers {
  private readonly transfers = new Map<string, Transfer>();
  private readonly revokedInstances = new Set<string>();
  private reserved = 0;
  private creating = 0;
  private readonly creations = new Map<string, Set<Promise<Transfer>>>();

  constructor(private readonly idleMs: number = LIMITS.idleMs) {}

  async beginWrite(
    owner: string,
    instance: string,
    itemPath: WorkspacePath,
    size: number,
    options: FileSystemWriteOptions = {},
  ): Promise<string> {
    if (!itemPath) throw new FsError('invalid-path', 'Cannot write the workspace root.');
    this.validateSize(size);
    return (await this.create(owner, instance, 'write', itemPath, size, options)).id;
  }

  async beginRead(
    owner: string,
    instance: string,
    itemPath: WorkspacePath,
    provider: NodeWorkspaceFileSystemV2,
  ) {
    // Reserve the maximum before opening: an external writer can grow the
    // source between a pathname stat and the descriptor read.
    const transfer = await this.create(owner, instance, 'read', itemPath, LIMITS.fileBytes);
    try {
      const entry = await this.use(transfer, () =>
        provider.readTo(itemPath, async (chunks) => {
          await transfer.handle.truncate(0);
          let offset = 0;
          for await (const chunk of chunks) {
            this.assertActive(transfer);
            await this.writeAt(transfer.handle, chunk, offset);
            offset += chunk.byteLength;
          }
        }),
      );
      if (!entry) {
        await this.close(owner, instance, transfer.id);
        return null;
      }
      transfer.size = entry.size;
      return { transferId: transfer.id, entry };
    } catch (error: unknown) {
      await this.close(owner, instance, transfer.id);
      throw error;
    }
  }

  writeChunk(
    owner: string,
    instance: string,
    id: string,
    offset: number,
    data: unknown,
  ): Promise<null> {
    const transfer = this.require(owner, instance, id, 'write');
    return this.use(transfer, async () => {
      if (!isBoundedBytePayload(data, LIMITS.chunkBytes) || data.byteLength === 0) {
        throw new FsError('quota-exceeded', 'Upload chunks must contain 1 byte to 4 MiB.');
      }
      this.validateOffset(transfer, offset);
      if (offset + data.byteLength > transfer.size)
        throw new FsError('quota-exceeded', 'Upload exceeds its declared size.');
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      await this.writeAt(transfer.handle, bytes, offset);
      transfer.offset += bytes.byteLength;
      return null;
    });
  }

  readChunk(owner: string, instance: string, id: string, offset: number): Promise<ArrayBuffer> {
    const transfer = this.require(owner, instance, id, 'read');
    return this.use(transfer, async () => {
      this.validateOffset(transfer, offset);
      const bytes = new Uint8Array(Math.min(LIMITS.chunkBytes, transfer.size - offset));
      let read = 0;
      while (read < bytes.byteLength) {
        const { bytesRead } = await transfer.handle.read(
          bytes,
          read,
          bytes.byteLength - read,
          offset + read,
        );
        if (bytesRead === 0) throw new FsError('corrupt', 'Recording transfer ended unexpectedly.');
        read += bytesRead;
      }
      transfer.offset += read;
      return bytes.buffer;
    });
  }

  async finishWrite(
    owner: string,
    instance: string,
    id: string,
    provider: NodeWorkspaceFileSystemV2,
  ): Promise<FileSystemFileSnapshot> {
    const transfer = this.require(owner, instance, id, 'write');
    try {
      return await this.use(transfer, async () => {
        if (transfer.offset !== transfer.size)
          throw new FsError('corrupt', 'Recording upload is incomplete.');
        const assertActive = () => this.assertActive(transfer);
        async function* chunks() {
          const bytes = new Uint8Array(LIMITS.chunkBytes);
          let offset = 0;
          while (offset < transfer.size) {
            assertActive();
            const { bytesRead } = await transfer.handle.read(
              bytes,
              0,
              Math.min(bytes.byteLength, transfer.size - offset),
              offset,
            );
            if (!bytesRead) throw new FsError('corrupt', 'Recording upload ended unexpectedly.');
            offset += bytesRead;
            yield bytes.subarray(0, bytesRead);
          }
          assertActive();
        }
        // Normal provider commit retains conditional versions, containment,
        // atomic replacement, and watch ordering for the whole file.
        return provider.writeStream(transfer.path, chunks(), transfer.size, transfer.options);
      });
    } finally {
      await this.close(owner, instance, id);
    }
  }

  close(owner: string, instance: string, id: string): Promise<void> {
    const transfer = this.transfers.get(id);
    if (!transfer || transfer.owner !== owner || transfer.instance !== instance)
      return Promise.resolve();
    if (transfer.closing) return transfer.closing;
    transfer.revoked = true;
    if (transfer.timer) clearTimeout(transfer.timer);
    transfer.closing = (async () => {
      await transfer.pending?.catch(() => undefined);
      await transfer.handle.close();
      await fs.unlink(transfer.file);
      await fs.rmdir(transfer.directory);
      // Retain the reservation if cleanup fails, so abandoned bytes cannot
      // accumulate beyond the spool budget while more uploads are accepted.
      this.transfers.delete(id);
      this.reserved -= transfer.reserved;
    })();
    return transfer.closing;
  }

  async dispose(owner: string, instance: string): Promise<void> {
    const key = `${owner}\0${instance}`;
    this.revokedInstances.add(key);
    await Promise.allSettled([...(this.creations.get(key) ?? [])]);
    await Promise.all(
      [...this.transfers.values()]
        .filter((t) => t.owner === owner && t.instance === instance)
        .map((t) => this.close(owner, instance, t.id)),
    );
  }

  private validateSize(size: number): void {
    if (!Number.isSafeInteger(size) || size < 0 || size > LIMITS.fileBytes)
      throw new FsError('quota-exceeded', 'File exceeds the 1 GiB desktop file limit.');
  }

  private create(
    owner: string,
    instance: string,
    kind: Transfer['kind'],
    itemPath: WorkspacePath,
    size: number,
    options: FileSystemWriteOptions = {},
  ): Promise<Transfer> {
    const key = `${owner}\0${instance}`;
    const pending = this.createSpool(owner, instance, kind, itemPath, size, options);
    const creations = this.creations.get(key) ?? new Set<Promise<Transfer>>();
    creations.add(pending);
    this.creations.set(key, creations);
    const settled = () => {
      creations.delete(pending);
      if (!creations.size) this.creations.delete(key);
    };
    void pending.then(settled, settled);
    return pending;
  }

  private async createSpool(
    owner: string,
    instance: string,
    kind: Transfer['kind'],
    itemPath: WorkspacePath,
    size: number,
    options: FileSystemWriteOptions = {},
  ): Promise<Transfer> {
    this.validateSize(size);
    const instanceKey = `${owner}\0${instance}`;
    if (this.revokedInstances.has(instanceKey))
      throw new FsError('closed', 'Recording transfer owner is closed.');
    if (
      this.transfers.size + this.creating >= LIMITS.transfers ||
      this.reserved + size > LIMITS.totalBytes
    )
      throw new FsError(
        'busy',
        'Too many recording transfers. Try again after the current transfer finishes.',
      );
    this.reserved += size;
    this.creating += 1;
    let directory: string | undefined;
    let handle: FileHandle | undefined;
    try {
      directory = await fs.mkdtemp(path.join(os.tmpdir(), 'docblocks-transfer-'));
      const file = path.join(directory, 'payload');
      handle = await fs.open(file, 'wx+', 0o600);
      if (this.revokedInstances.has(instanceKey))
        throw new FsError('closed', 'Recording transfer owner is closed.');
      const transfer: Transfer = {
        id: randomUUID(),
        owner,
        instance,
        kind,
        path: itemPath,
        options: { ...options },
        directory,
        file,
        handle,
        reserved: size,
        size,
        offset: 0,
        deadline: Date.now() + LIMITS.lifetimeMs,
        revoked: false,
        pending: null,
        closing: null,
        timer: null,
      };
      this.transfers.set(transfer.id, transfer);
      this.armTimer(transfer);
      return transfer;
    } catch (error: unknown) {
      await handle?.close();
      if (directory) {
        await fs.unlink(path.join(directory, 'payload')).catch((failure: unknown) => {
          if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure;
        });
        await fs.rmdir(directory);
      }
      this.reserved -= size;
      throw error;
    } finally {
      this.creating -= 1;
    }
  }

  private require(owner: string, instance: string, id: string, kind: Transfer['kind']): Transfer {
    const transfer = this.transfers.get(id);
    if (
      !transfer ||
      transfer.owner !== owner ||
      transfer.instance !== instance ||
      transfer.kind !== kind
    )
      throw new FsError('closed', 'Recording transfer is unavailable.');
    this.assertActive(transfer);
    return transfer;
  }

  private assertActive(transfer: Transfer): void {
    if (transfer.revoked || Date.now() >= transfer.deadline)
      throw new FsError('closed', 'Recording transfer expired or was cancelled.');
  }

  private validateOffset(transfer: Transfer, offset: number): void {
    if (!Number.isSafeInteger(offset) || offset !== transfer.offset || offset > transfer.size)
      throw new FsError('invalid-path', 'Recording chunks must be transferred in order.');
  }

  private async writeAt(handle: FileHandle, bytes: Uint8Array, offset: number): Promise<void> {
    let written = 0;
    while (written < bytes.byteLength) {
      const { bytesWritten } = await handle.write(
        bytes,
        written,
        bytes.byteLength - written,
        offset + written,
      );
      if (!bytesWritten) throw new FsError('io', 'Recording transfer could not write its data.');
      written += bytesWritten;
    }
  }

  private use<T>(transfer: Transfer, work: () => Promise<T>): Promise<T> {
    this.assertActive(transfer);
    if (transfer.pending)
      throw new FsError('busy', 'A recording transfer request is already in progress.');
    if (transfer.timer) clearTimeout(transfer.timer);
    // The absolute deadline still applies to a stalled request.
    const pending = Promise.resolve().then(work);
    transfer.pending = pending;
    this.armTimer(transfer, true);
    return pending.finally(() => {
      transfer.pending = null;
      if (!transfer.revoked) this.armTimer(transfer);
    });
  }

  private armTimer(transfer: Transfer, pending = false): void {
    if (transfer.timer) clearTimeout(transfer.timer);
    const remaining = Math.max(1, transfer.deadline - Date.now());
    transfer.timer = setTimeout(
      () => {
        void this.close(transfer.owner, transfer.instance, transfer.id).catch((error: unknown) => {
          process.stderr.write(`Filesystem transfer cleanup failed: ${String(error)}\n`);
        });
      },
      pending ? remaining : Math.min(this.idleMs, remaining),
    );
    transfer.timer.unref();
  }
}
