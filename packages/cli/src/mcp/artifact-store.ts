import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MCP_WIRE_LIMITS,
  parseConversionResult,
  type AppliedOption,
  type ArtifactRef,
  type ConversionResult,
  type EngineVersion,
} from '@bendyline/docblocks/mcp';
import {
  cancellationError,
  throwIfAborted as throwIfSignalAborted,
} from '../internal/cancellation.js';

const DEFAULT_MAX_ARTIFACT_BYTES = 500 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_ARTIFACTS = 64;
const DEFAULT_ARTIFACT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_RESOURCE_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_REPORT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_REPORT_TOTAL_BYTES = 64 * 1024 * 1024;
const ARTIFACT_IO_CHUNK_BYTES = 1024 * 1024;
const ARTIFACT_IO_DISPOSE_DRAIN_MS = 250;

export const MCP_ARTIFACT_STORE_LIMITS = Object.freeze({
  maxArtifactBytes: MCP_WIRE_LIMITS.artifactBytes,
  maxArtifactTotalBytes: 4 * 1024 * 1024 * 1024,
  maxArtifactCount: 1_024,
  artifactTtlMs: 24 * 60 * 60 * 1_000,
  maxArtifactResourceBytes: 100 * 1024 * 1024,
  maxArtifactReportBytes: 32 * 1024 * 1024,
  maxArtifactReportTotalBytes: 256 * 1024 * 1024,
});

export interface ArtifactStoreOptions {
  maxArtifactBytes?: number;
  maxArtifactTotalBytes?: number;
  maxArtifactCount?: number;
  artifactTtlMs?: number;
  maxArtifactResourceBytes?: number;
  maxArtifactReportBytes?: number;
  maxArtifactReportTotalBytes?: number;
}

export interface PutArtifactOptions {
  bytes: Uint8Array;
  format: string;
  mimeType: string;
  sourceFormat?: string | null;
  sourceSha256?: string | null;
  suggestedFilename: string;
  appliedOptions?: readonly AppliedOption[];
  engineVersions?: readonly EngineVersion[];
}

interface ArtifactReadOptions {
  signal: AbortSignal;
  maximumBytes: number;
  expectedBytes: number;
}

interface ArtifactStoreDependencies {
  readFile(path: string, options: ArtifactReadOptions): Promise<Buffer>;
  writeFile(path: string, bytes: Buffer, signal: AbortSignal): Promise<void>;
}

const DEFAULT_ARTIFACT_STORE_DEPENDENCIES: ArtifactStoreDependencies = Object.freeze({
  readFile: readFileCancellable,
  writeFile: writeFileCancellable,
});

interface StoredArtifact {
  ref: ArtifactRef;
  path: string;
  conversionReport: string | null;
  reportBytes: number;
  activeReaders: number;
  pendingDelete: boolean;
}

interface ArtifactIoLease {
  controller: AbortController;
  done: Promise<void>;
  complete: () => void;
  detachExternalSignal: () => void;
}

interface ArtifactReservation {
  bytes: number;
  active: boolean;
}

/**
 * Per-server immutable artifact storage. Artifacts are deliberately scoped to
 * one MCP server instance: an opaque URI from another session conveys no
 * authority and cannot be resolved here.
 */
export class ArtifactStore {
  private readonly directory: Promise<string>;
  private readonly records = new Map<string, StoredArtifact>();
  private readonly maximumArtifactBytes: number;
  private readonly maximumTotalBytes: number;
  private readonly maximumCount: number;
  private readonly ttlMs: number;
  private readonly maximumResourceBytes: number;
  private readonly maximumReportBytes: number;
  private readonly maximumReportTotalBytes: number;
  private totalBytes = 0;
  private totalReportBytes = 0;
  private reservedBytes = 0;
  private reservedCount = 0;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;
  private readonly activeIo = new Set<ArtifactIoLease>();
  private tail: Promise<void> = Promise.resolve();
  private readonly dependencies: ArtifactStoreDependencies;

  public constructor(
    options: ArtifactStoreOptions = {},
    dependencies: Partial<ArtifactStoreDependencies> = {},
  ) {
    this.dependencies = { ...DEFAULT_ARTIFACT_STORE_DEPENDENCIES, ...dependencies };
    this.maximumArtifactBytes = positiveInteger(
      options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES,
      'artifact byte limit',
      MCP_ARTIFACT_STORE_LIMITS.maxArtifactBytes,
    );
    this.maximumTotalBytes = positiveInteger(
      options.maxArtifactTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
      'artifact total-byte limit',
      MCP_ARTIFACT_STORE_LIMITS.maxArtifactTotalBytes,
    );
    this.maximumCount = positiveInteger(
      options.maxArtifactCount ?? DEFAULT_MAX_ARTIFACTS,
      'artifact count limit',
      MCP_ARTIFACT_STORE_LIMITS.maxArtifactCount,
    );
    this.ttlMs = positiveInteger(
      options.artifactTtlMs ?? DEFAULT_ARTIFACT_TTL_MS,
      'artifact TTL',
      MCP_ARTIFACT_STORE_LIMITS.artifactTtlMs,
    );
    this.maximumResourceBytes = positiveInteger(
      options.maxArtifactResourceBytes ?? DEFAULT_MAX_RESOURCE_BYTES,
      'artifact resource byte limit',
      MCP_ARTIFACT_STORE_LIMITS.maxArtifactResourceBytes,
    );
    this.maximumReportBytes = positiveInteger(
      options.maxArtifactReportBytes ?? DEFAULT_MAX_REPORT_BYTES,
      'artifact report byte limit',
      MCP_ARTIFACT_STORE_LIMITS.maxArtifactReportBytes,
    );
    this.maximumReportTotalBytes = positiveInteger(
      options.maxArtifactReportTotalBytes ?? DEFAULT_MAX_REPORT_TOTAL_BYTES,
      'artifact report total-byte limit',
      MCP_ARTIFACT_STORE_LIMITS.maxArtifactReportTotalBytes,
    );
    if (this.maximumTotalBytes < this.maximumArtifactBytes) {
      throw new Error('Artifact total-byte limit must be at least the per-artifact limit');
    }
    if (this.maximumReportTotalBytes < this.maximumReportBytes) {
      throw new Error('Artifact report total-byte limit must be at least the per-report limit');
    }
    this.directory = mkdtemp(join(tmpdir(), 'docblocks-mcp-artifacts-'));
    // Construction is synchronous for server setup, while the backing
    // directory is not. Observe failure immediately and expose it through
    // ready() so transport admission can fail deterministically.
    void this.directory.catch(() => undefined);
  }

  /** Resolve only after the session-scoped backing directory exists. */
  public async ready(): Promise<void> {
    await this.directory;
  }

  public async put(options: PutArtifactOptions, signal?: AbortSignal): Promise<ArtifactRef> {
    throwIfAborted(signal);
    const bytes = Buffer.from(options.bytes);
    if (bytes.byteLength > this.maximumArtifactBytes) {
      throw new Error('MCP artifact exceeds the configured per-artifact limit');
    }
    const sha256 = await hashBytesCancellable(bytes, signal);
    const id = randomUUID();
    const path = join(await this.directory, `${id}.artifact`);
    throwIfAborted(signal);
    const created = new Date();
    const ref = immutableArtifactRef({
      id,
      uri: `docblocks://artifacts/${id}`,
      format: options.format,
      mimeType: options.mimeType,
      size: bytes.byteLength,
      sha256,
      sourceFormat: options.sourceFormat ?? null,
      sourceSha256: options.sourceSha256 ?? null,
      suggestedFilename: options.suggestedFilename,
      appliedOptions: options.appliedOptions ?? [],
      engineVersions: options.engineVersions ?? [],
      createdAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + this.ttlMs).toISOString(),
    });
    const reservation: ArtifactReservation = { bytes: bytes.byteLength, active: true };
    const acquisition = await this.lock(() => {
      this.assertActive();
      throwIfAborted(signal);
      const expiredPaths = this.takeExpiredLocked();
      if (this.records.size + this.reservedCount >= this.maximumCount) {
        throw new Error('MCP artifact store reached its configured count limit');
      }
      if (this.totalBytes + this.reservedBytes + bytes.byteLength > this.maximumTotalBytes) {
        throw new Error('MCP artifact store reached its configured total-byte limit');
      }
      this.reservedCount += 1;
      this.reservedBytes += bytes.byteLength;
      return { expiredPaths, io: this.createIoLeaseLocked(signal) };
    });
    await removeFilesBestEffort(acquisition.expiredPaths);

    try {
      await this.dependencies.writeFile(path, bytes, acquisition.io.controller.signal);
      throwIfAborted(acquisition.io.controller.signal);
      await this.lock(() => {
        this.assertActive();
        throwIfAborted(acquisition.io.controller.signal);
        this.releaseReservationLocked(reservation);
        this.records.set(id, {
          ref,
          path,
          conversionReport: null,
          reportBytes: 0,
          activeReaders: 0,
          pendingDelete: false,
        });
        this.totalBytes += bytes.byteLength;
      });
      // Publication is the commit boundary. Cancellation after this point must
      // not report a failure for an artifact that is already discoverable.
      return ref;
    } catch (caught: unknown) {
      await this.lock(() => this.releaseReservationLocked(reservation));
      await rm(path, { force: true }).catch(() => undefined);
      throw caught;
    } finally {
      this.completeIoLease(acquisition.io);
    }
  }

  public async get(uriOrId: string, signal?: AbortSignal): Promise<ArtifactRef> {
    throwIfAborted(signal);
    return (await this.record(uriOrId)).ref;
  }

  /** Persist the exact bounded conversion report beside its immutable artifact. */
  public async attachConversionReport(report: ConversionResult): Promise<void> {
    const parsed = parseConversionResult(report);
    if (!parsed) throw new Error('Invalid MCP conversion report');
    const serialized = JSON.stringify(parsed);
    const reportBytes = Buffer.byteLength(serialized, 'utf8');
    if (reportBytes > this.maximumReportBytes) {
      throw new Error('MCP conversion report exceeds the configured byte limit');
    }
    await this.lock(() => {
      this.assertActive();
      const stored = this.records.get(artifactId(parsed.artifact.uri));
      if (!stored || !sameArtifact(stored.ref, parsed.artifact)) {
        throw new Error('Conversion report does not match an active MCP artifact');
      }
      const nextTotal = this.totalReportBytes - stored.reportBytes + reportBytes;
      if (nextTotal > this.maximumReportTotalBytes) {
        throw new Error('MCP conversion reports exceed the configured aggregate byte limit');
      }
      // `put()` and this attachment are one publication lifecycle in the
      // conversion service. Do not let an intentionally tiny test TTL split
      // those two steps; ordinary reads still enforce expiration immediately.
      stored.conversionReport = serialized;
      this.totalReportBytes = nextTotal;
      stored.reportBytes = reportBytes;
    });
  }

  /** Retrieve a fresh validated copy of an artifact's original conversion report. */
  public async getConversionReport(uriOrId: string): Promise<ConversionResult> {
    const stored = await this.record(uriOrId);
    if (!stored.conversionReport) throw new Error('MCP artifact has no conversion report');
    const parsed = parseConversionResult(JSON.parse(stored.conversionReport) as unknown);
    if (!parsed) throw new Error('Stored MCP conversion report is corrupt');
    return parsed;
  }

  /** Remove an unpublished artifact after a later atomic lifecycle step fails. */
  public async discard(uriOrId: string): Promise<void> {
    const removed = await this.lock(() => {
      this.assertActive();
      const expiredPaths = this.takeExpiredLocked();
      const id = artifactId(uriOrId);
      const stored = this.records.get(id);
      return {
        expiredPaths,
        path: stored ? this.removeRecordLocked(id, stored) : null,
      };
    });
    await removeFilesBestEffort(removed.expiredPaths);
    if (removed.path) await rm(removed.path, { force: true });
  }

  public async read(uriOrId: string, signal?: AbortSignal): Promise<Buffer> {
    return this.readBytes(uriOrId, this.maximumArtifactBytes, signal);
  }

  /** Resource reads are opt-in but still bounded to avoid accidental huge base64 responses. */
  public async readResource(
    uriOrId: string,
    signal?: AbortSignal,
  ): Promise<{ ref: ArtifactRef; bytes: Buffer }> {
    const result = await this.readBytesWithRef(uriOrId, this.maximumResourceBytes, signal, true);
    return { ref: result.ref, bytes: result.bytes };
  }

  public async completeIds(prefix: string): Promise<string[]> {
    const result = await this.lock(() => {
      this.assertActive();
      return {
        expiredPaths: this.takeExpiredLocked(),
        ids: [...this.records.keys()]
          .filter((id) => id.startsWith(prefix))
          .sort()
          .slice(0, 100),
      };
    });
    await removeFilesBestEffort(result.expiredPaths);
    return result.ids;
  }

  /** Complete only artifacts that have an attached conversion report. */
  public async completeReportIds(prefix: string): Promise<string[]> {
    const result = await this.lock(() => {
      this.assertActive();
      return {
        expiredPaths: this.takeExpiredLocked(),
        ids: [...this.records.entries()]
          .filter(([id, stored]) => id.startsWith(prefix) && stored.conversionReport !== null)
          .map(([id]) => id)
          .sort()
          .slice(0, 100),
      };
    });
    await removeFilesBestEffort(result.expiredPaths);
    return result.ids;
  }

  public dispose(): Promise<void> {
    this.disposePromise ??= this.disposeOnce();
    return this.disposePromise;
  }

  private async record(uriOrId: string): Promise<StoredArtifact> {
    const result = await this.lock(() => {
      this.assertActive();
      const expiredPaths = this.takeExpiredLocked();
      return { expiredPaths, stored: this.findRecordLocked(uriOrId) };
    });
    await removeFilesBestEffort(result.expiredPaths);
    return result.stored;
  }

  private findRecordLocked(uriOrId: string): StoredArtifact {
    const id = artifactId(uriOrId);
    const stored = this.records.get(id);
    if (!stored) throw new Error('Unknown or expired MCP artifact');
    return stored;
  }

  private takeExpiredLocked(): string[] {
    const now = Date.now();
    const paths: string[] = [];
    for (const [id, stored] of this.records) {
      const expiresAt = stored.ref.expiresAt
        ? Date.parse(stored.ref.expiresAt)
        : Number.POSITIVE_INFINITY;
      if (expiresAt > now) continue;
      const path = this.removeRecordLocked(id, stored);
      if (path) paths.push(path);
    }
    return paths;
  }

  private async readBytes(
    uriOrId: string,
    maximumBytes: number,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    return (await this.readBytesWithRef(uriOrId, maximumBytes, signal, false)).bytes;
  }

  private async readBytesWithRef(
    uriOrId: string,
    maximumBytes: number,
    signal: AbortSignal | undefined,
    resourceRead: boolean,
  ): Promise<{ ref: ArtifactRef; bytes: Buffer }> {
    throwIfAborted(signal);
    const acquisition = await this.lock(() => {
      this.assertActive();
      throwIfAborted(signal);
      const expiredPaths = this.takeExpiredLocked();
      const stored = this.findRecordLocked(uriOrId);
      if (stored.ref.size > maximumBytes) {
        if (resourceRead) {
          throw new Error('Artifact is too large for an MCP resource response; use save_artifact');
        }
        throw new Error('MCP artifact exceeds the configured read byte limit');
      }
      const io = this.createIoLeaseLocked(signal);
      stored.activeReaders += 1;
      return { expiredPaths, stored, io };
    });
    await removeFilesBestEffort(acquisition.expiredPaths);

    try {
      const bytes = await this.dependencies.readFile(acquisition.stored.path, {
        signal: acquisition.io.controller.signal,
        maximumBytes,
        expectedBytes: acquisition.stored.ref.size,
      });
      throwIfAborted(acquisition.io.controller.signal);
      if (bytes.byteLength !== acquisition.stored.ref.size) {
        throw new Error('Stored MCP artifact byte length does not match its immutable metadata');
      }
      return { ref: acquisition.stored.ref, bytes };
    } finally {
      let deletePath: string | null = null;
      await this.lock(() => {
        acquisition.stored.activeReaders -= 1;
        if (acquisition.stored.activeReaders === 0 && acquisition.stored.pendingDelete) {
          deletePath = acquisition.stored.path;
        }
      });
      this.completeIoLease(acquisition.io);
      if (deletePath) await rm(deletePath, { force: true }).catch(() => undefined);
    }
  }

  private removeRecordLocked(id: string, stored: StoredArtifact): string | null {
    this.records.delete(id);
    this.totalBytes -= stored.ref.size;
    this.totalReportBytes -= stored.reportBytes;
    if (stored.activeReaders > 0) {
      stored.pendingDelete = true;
      return null;
    }
    return stored.path;
  }

  private releaseReservationLocked(reservation: ArtifactReservation): void {
    if (!reservation.active) return;
    reservation.active = false;
    this.reservedCount -= 1;
    this.reservedBytes -= reservation.bytes;
  }

  private createIoLeaseLocked(externalSignal?: AbortSignal): ArtifactIoLease {
    throwIfAborted(externalSignal);
    const controller = new AbortController();
    const forwardCancellation = (): void =>
      controller.abort(
        externalSignal?.reason ?? cancellationError('MCP artifact I/O was cancelled'),
      );
    if (externalSignal)
      externalSignal.addEventListener('abort', forwardCancellation, { once: true });
    let resolveDone: () => void = () => undefined;
    let completed = false;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const lease: ArtifactIoLease = {
      controller,
      done,
      complete: () => {
        if (completed) return;
        completed = true;
        resolveDone();
      },
      detachExternalSignal: () => externalSignal?.removeEventListener('abort', forwardCancellation),
    };
    this.activeIo.add(lease);
    return lease;
  }

  private completeIoLease(lease: ArtifactIoLease): void {
    lease.detachExternalSignal();
    this.activeIo.delete(lease);
    lease.complete();
  }

  private async disposeOnce(): Promise<void> {
    const leases = await this.lock(() => {
      if (this.disposed) return [] as ArtifactIoLease[];
      this.disposed = true;
      for (const stored of this.records.values()) stored.pendingDelete = true;
      this.records.clear();
      this.totalBytes = 0;
      this.totalReportBytes = 0;
      const current = [...this.activeIo];
      const reason = new Error('MCP artifact store is disposed');
      reason.name = 'ArtifactStoreDisposedError';
      for (const lease of current) {
        if (!lease.controller.signal.aborted) lease.controller.abort(reason);
      }
      return current;
    });
    await waitForIoDrain(leases, ARTIFACT_IO_DISPOSE_DRAIN_MS);
    for (const lease of leases) {
      lease.detachExternalSignal();
      this.activeIo.delete(lease);
    }
    await rm(await this.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('MCP artifact store is disposed');
  }

  private async lock<T>(work: () => T | Promise<T>): Promise<T> {
    let release: (() => void) | undefined;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release?.();
    }
  }
}

function artifactId(uriOrId: string): string {
  const artifactIdPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  if (artifactIdPattern.test(uriOrId)) {
    return uriOrId;
  }
  let parsed: URL;
  try {
    parsed = new URL(uriOrId);
  } catch {
    throw new Error('Invalid MCP artifact URI');
  }
  const id = parsed.pathname.slice(1);
  if (
    parsed.protocol !== 'docblocks:' ||
    parsed.hostname !== 'artifacts' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.pathname !== `/${id}` ||
    !artifactIdPattern.test(id) ||
    uriOrId !== `docblocks://artifacts/${id}`
  ) {
    throw new Error('Invalid MCP artifact URI');
  }
  return id;
}

function positiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Invalid MCP ${label}; maximum is ${maximum}`);
  }
  return value;
}

function sameArtifact(left: ArtifactRef, right: ArtifactRef): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Clone and freeze every caller-controlled layer before metadata enters quota accounting. */
function immutableArtifactRef(ref: ArtifactRef): ArtifactRef {
  const appliedOptions = Object.freeze(
    ref.appliedOptions.map((option) => Object.freeze({ ...option })),
  );
  const engineVersions = Object.freeze(
    ref.engineVersions.map((engine) => Object.freeze({ ...engine })),
  );
  return Object.freeze({ ...ref, appliedOptions, engineVersions });
}

async function writeFileCancellable(
  path: string,
  bytes: Buffer,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const handle = await open(path, 'wx');
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      throwIfAborted(signal);
      const length = Math.min(ARTIFACT_IO_CHUNK_BYTES, bytes.byteLength - offset);
      const { bytesWritten } = await handle.write(bytes, offset, length, offset);
      if (bytesWritten < 1) throw new Error('Artifact write made no progress');
      offset += bytesWritten;
    }
    throwIfAborted(signal);
  } finally {
    await handle.close();
  }
}

async function readFileCancellable(path: string, options: ArtifactReadOptions): Promise<Buffer> {
  throwIfAborted(options.signal);
  const handle = await open(path, 'r');
  try {
    const stats = await handle.stat();
    throwIfAborted(options.signal);
    if (stats.size > options.maximumBytes) {
      throw new Error('Stored MCP artifact exceeds the configured read byte limit');
    }
    if (stats.size !== options.expectedBytes) {
      throw new Error('Stored MCP artifact byte length does not match its immutable metadata');
    }
    const bytes = Buffer.allocUnsafe(stats.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      throwIfAborted(options.signal);
      const length = Math.min(ARTIFACT_IO_CHUNK_BYTES, bytes.byteLength - offset);
      const { bytesRead } = await handle.read(bytes, offset, length, offset);
      if (bytesRead < 1) {
        throw new Error('Stored MCP artifact ended before its immutable byte length');
      }
      offset += bytesRead;
    }
    throwIfAborted(options.signal);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function hashBytesCancellable(bytes: Buffer, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for (let offset = 0; offset < bytes.byteLength; offset += ARTIFACT_IO_CHUNK_BYTES) {
    throwIfAborted(signal);
    hash.update(bytes.subarray(offset, offset + ARTIFACT_IO_CHUNK_BYTES));
    if (offset + ARTIFACT_IO_CHUNK_BYTES < bytes.byteLength) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  throwIfAborted(signal);
  return hash.digest('hex');
}

async function removeFilesBestEffort(paths: readonly string[]): Promise<void> {
  await Promise.allSettled(paths.map((path) => rm(path, { force: true })));
}

async function waitForIoDrain(
  leases: readonly ArtifactIoLease[],
  timeoutMs: number,
): Promise<void> {
  if (leases.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(leases.map((lease) => lease.done)).then(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  throwIfSignalAborted(signal, 'MCP artifact I/O was cancelled');
}
