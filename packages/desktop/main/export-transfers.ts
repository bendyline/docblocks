import { randomUUID } from 'node:crypto';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { EXPORT_TRANSFER_LIMITS, isBoundedBytePayload } from '@bendyline/docblocks/host';

/** Where a chunked export is headed, settled from its grant before any bytes move. */
export interface ExportUploadTarget {
  documentKey: string;
  filename: string;
  grantId: string;
  /** The granted path. Its spool lives in the same directory, so publish is a rename. */
  absolutePath: string;
}

/** A complete, synced spool handed to the publisher. */
export interface CompletedExportUpload extends ExportUploadTarget {
  temporaryPath: string;
  size: number;
}

export type ExportTransferLimits = typeof EXPORT_TRANSFER_LIMITS;

interface ExportUpload {
  id: string;
  ownerId: number;
  target: ExportUploadTarget;
  temporaryPath: string;
  handle: FileHandle;
  size: number;
  offset: number;
  deadline: number;
  revoked: boolean;
  pending: Promise<unknown> | null;
  closing: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
}

function reportCleanupFailure(error: unknown): void {
  process.stderr.write(`Export upload cleanup failed: ${String(error)}\n`);
}

function formatByteLimit(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  return Number.isInteger(gib) ? `${gib} GiB` : `${bytes}-byte`;
}

/**
 * Owner-scoped, expiring export uploads. Chunks land in a hidden spool beside
 * the granted target; nothing replaces the target until the whole payload has
 * arrived, been synced, and cleared the publisher's checks.
 */
export class ExportTransfers {
  private readonly uploads = new Map<string, ExportUpload>();
  private readonly ownerGenerations = new Map<number, number>();
  private opening = 0;

  constructor(private readonly limits: ExportTransferLimits = EXPORT_TRANSFER_LIMITS) {}

  async begin(ownerId: number, target: ExportUploadTarget, size: unknown): Promise<string> {
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1) {
      throw new Error('Invalid export size');
    }
    if (size > this.limits.fileBytes) {
      throw new Error(
        `This export is larger than the ${formatByteLimit(this.limits.fileBytes)} desktop export limit.`,
      );
    }
    if (this.uploads.size + this.opening >= this.limits.transfers) {
      throw new Error('Too many exports are being saved. Try again once one of them finishes.');
    }
    const generation = this.ownerGenerations.get(ownerId) ?? 0;
    const temporaryPath = path.join(
      path.dirname(target.absolutePath),
      `.${path.basename(target.absolutePath)}.${randomUUID()}.tmp`,
    );
    this.opening += 1;
    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(temporaryPath, 'wx', 0o600);
      // The renderer may have navigated away while the spool was opening.
      if ((this.ownerGenerations.get(ownerId) ?? 0) !== generation) {
        throw new Error('Export upload owner is closed.');
      }
      const upload: ExportUpload = {
        id: `export-upload_${randomUUID()}`,
        ownerId,
        target: { ...target },
        temporaryPath,
        handle,
        size,
        offset: 0,
        deadline: Date.now() + this.limits.lifetimeMs,
        revoked: false,
        pending: null,
        closing: null,
        timer: null,
      };
      this.uploads.set(upload.id, upload);
      this.armTimer(upload);
      return upload.id;
    } catch (error: unknown) {
      if (handle) {
        await handle.close();
        await fs.unlink(temporaryPath).catch(reportCleanupFailure);
      }
      throw error;
    } finally {
      this.opening -= 1;
    }
  }

  writeChunk(ownerId: number, id: string, offset: unknown, data: unknown): Promise<void> {
    const upload = this.require(ownerId, id);
    return this.use(upload, async () => {
      if (!isBoundedBytePayload(data, this.limits.chunkBytes) || data.byteLength === 0) {
        throw new Error('Export chunk size is invalid.');
      }
      if (offset !== upload.offset) throw new Error('Export chunks must arrive in order.');
      if (upload.offset + data.byteLength > upload.size) {
        throw new Error('Export upload exceeds its declared size.');
      }
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      let written = 0;
      while (written < bytes.byteLength) {
        const { bytesWritten } = await upload.handle.write(
          bytes,
          written,
          bytes.byteLength - written,
          upload.offset + written,
        );
        if (!bytesWritten) throw new Error('Export upload could not write its data.');
        written += bytesWritten;
      }
      upload.offset += written;
    });
  }

  /**
   * Seal a complete upload and hand it to `publish`, which must move the spool
   * onto the target or leave it in place. The spool is discarded either way.
   */
  async finish<T>(
    ownerId: number,
    id: string,
    publish: (upload: CompletedExportUpload) => Promise<T>,
  ): Promise<T> {
    const upload = this.require(ownerId, id);
    try {
      return await this.use(upload, async () => {
        if (upload.offset !== upload.size) throw new Error('Export upload is incomplete.');
        await upload.handle.sync();
        await upload.handle.close();
        return publish({
          ...upload.target,
          temporaryPath: upload.temporaryPath,
          size: upload.size,
        });
      });
    } finally {
      await this.close(ownerId, id).catch(reportCleanupFailure);
    }
  }

  /** The granted path an upload is headed for, so its failures can name the file. */
  targetPath(ownerId: number, id: string): string | null {
    const upload = this.uploads.get(id);
    return upload?.ownerId === ownerId ? upload.target.absolutePath : null;
  }

  /** Discard one upload. Unknown or foreign ids are a no-op. */
  close(ownerId: number, id: string): Promise<void> {
    const upload = this.uploads.get(id);
    if (!upload || upload.ownerId !== ownerId) return Promise.resolve();
    return this.discard(upload);
  }

  /** Discard every upload a renderer owns, including any still opening. */
  async revokeOwner(ownerId: number): Promise<void> {
    this.ownerGenerations.set(ownerId, (this.ownerGenerations.get(ownerId) ?? 0) + 1);
    await Promise.all(
      [...this.uploads.values()]
        .filter((upload) => upload.ownerId === ownerId)
        .map((upload) => this.discard(upload)),
    );
  }

  private discard(upload: ExportUpload): Promise<void> {
    if (upload.closing) return upload.closing;
    upload.revoked = true;
    if (upload.timer) clearTimeout(upload.timer);
    upload.closing = (async () => {
      await upload.pending?.catch(() => undefined);
      try {
        await upload.handle.close();
        await fs.unlink(upload.temporaryPath).catch((error: unknown) => {
          // A published spool has already been renamed onto its target.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
      } finally {
        this.uploads.delete(upload.id);
      }
    })();
    return upload.closing;
  }

  private require(ownerId: number, id: string): ExportUpload {
    const upload = this.uploads.get(id);
    if (!upload || upload.ownerId !== ownerId) throw new Error('Export upload is unavailable.');
    this.assertActive(upload);
    return upload;
  }

  private assertActive(upload: ExportUpload): void {
    if (upload.revoked || Date.now() >= upload.deadline) {
      throw new Error('Export upload expired or was cancelled.');
    }
  }

  private use<T>(upload: ExportUpload, work: () => Promise<T>): Promise<T> {
    this.assertActive(upload);
    if (upload.pending) throw new Error('An export upload request is already in progress.');
    const pending = Promise.resolve().then(work);
    upload.pending = pending;
    // The absolute deadline still applies to a stalled request.
    this.armTimer(upload, true);
    return pending.finally(() => {
      upload.pending = null;
      if (!upload.revoked) this.armTimer(upload);
    });
  }

  private armTimer(upload: ExportUpload, pending = false): void {
    if (upload.timer) clearTimeout(upload.timer);
    const remaining = Math.max(1, upload.deadline - Date.now());
    upload.timer = setTimeout(
      () => void this.discard(upload).catch(reportCleanupFailure),
      pending ? remaining : Math.min(this.limits.idleMs, remaining),
    );
    upload.timer.unref();
  }
}
