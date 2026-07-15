import { lstat, link, open, realpath, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { MCP_WIRE_LIMITS } from '@bendyline/docblocks/mcp';
import { readContainedFile } from '../contained-file.js';
import { isLinkUnsupportedError } from '../internal/link-support.js';
import { isNodeErrorCode } from '../internal/node-error.js';
import { isPathInside } from '../internal/paths.js';

export interface McpFileAuthorityOptions {
  readRoots?: readonly string[];
  writeRoots?: readonly string[];
  maxInputFileBytes?: number;
}

export interface McpFileAuthorityDependencies {
  /** Test seam after each bounded input read chunk, before cancellation is rechecked. */
  afterInputReadChunk?(readBytes: number, totalBytes: number): Promise<void> | void;
  /** Test seam after durable staging but before the final precondition check. */
  afterMaterializationStage?(temporaryPath: string): Promise<void> | void;
  /** Test seam after each bounded write chunk, before cancellation is rechecked. */
  afterMaterializationWriteChunk?(writtenBytes: number, totalBytes: number): Promise<void> | void;
  /** Test seam after each bounded hash chunk, before cancellation is rechecked. */
  afterMaterializationHashChunk?(readBytes: number, totalBytes: number): Promise<void> | void;
  /** Synchronous test notification at the irreversible publication boundary. */
  afterMaterializationPublish?(targetPath: string): void;
  /** Test seam standing in for a filesystem whose hard links are unsupported. */
  link?(existingPath: string, newPath: string): Promise<void>;
}

const DEFAULT_MAX_INPUT_FILE_BYTES = 100 * 1024 * 1024;
export const MCP_FILE_AUTHORITY_LIMITS = Object.freeze({
  maxInputFileBytes: 1024 * 1024 * 1024,
  maxRootsPerCapability: 64,
});
const MAX_PATH_CHARACTERS = 4_096;
const MATERIALIZATION_WRITE_CHUNK_BYTES = 1024 * 1024;
const HASH_READ_CHUNK_BYTES = 64 * 1024;
const materializationTails = new Map<string, Promise<void>>();

interface PhysicalRoot {
  id: string;
  lexical: string;
  physical: string;
}

interface MaterializationParentIdentity {
  physical: string;
  dev: number;
  ino: number;
}

export interface McpRootDescriptor {
  id: string;
  label: string;
  read: boolean;
  write: boolean;
}

export interface McpMaterializationOptions {
  ifExists?: 'error' | 'replace';
  expectedSha256?: string;
  signal?: AbortSignal;
}

/** Host-startup authority. Tool arguments can narrow it but can never expand it. */
export class McpFileAuthority {
  private constructor(
    private readonly readRoots: readonly PhysicalRoot[],
    private readonly writeRoots: readonly PhysicalRoot[],
    private readonly maxInputFileBytes: number,
    private readonly dependencies: McpFileAuthorityDependencies,
  ) {}

  public static async create(
    options: McpFileAuthorityOptions = {},
    dependencies: McpFileAuthorityDependencies = {},
  ): Promise<McpFileAuthority> {
    const maxInputFileBytes = options.maxInputFileBytes ?? DEFAULT_MAX_INPUT_FILE_BYTES;
    if (
      !Number.isSafeInteger(maxInputFileBytes) ||
      maxInputFileBytes < 1 ||
      maxInputFileBytes > MCP_FILE_AUTHORITY_LIMITS.maxInputFileBytes
    ) {
      throw new Error('Invalid MCP input file limit');
    }
    if (
      (options.readRoots?.length ?? 0) > MCP_FILE_AUTHORITY_LIMITS.maxRootsPerCapability ||
      (options.writeRoots?.length ?? 0) > MCP_FILE_AUTHORITY_LIMITS.maxRootsPerCapability
    ) {
      throw new Error('MCP authority has too many configured roots');
    }
    return new McpFileAuthority(
      await resolveRoots(options.readRoots ?? []),
      await resolveRoots(options.writeRoots ?? []),
      maxInputFileBytes,
      dependencies,
    );
  }

  public async authorizeRead(requestedPath: string): Promise<string> {
    const candidate = validatePath(requestedPath);
    const physical = await realpath(candidate).catch(() => null);
    if (!physical || !this.readRoots.some((root) => isPathInside(root.physical, physical))) {
      throw new Error('MCP read path is outside the configured roots');
    }
    const info = await stat(physical);
    if (!info.isFile()) throw new Error('MCP input must be a regular file');
    if (info.size > this.maxInputFileBytes) {
      throw new Error('MCP input exceeds the configured file-size limit');
    }
    return physical;
  }

  /** Opaque, non-authoritative aliases for the roots granted at server startup. */
  public listRoots(): McpRootDescriptor[] {
    const roots = new Map<string, McpRootDescriptor>();
    for (const root of this.readRoots) {
      roots.set(root.id, {
        id: root.id,
        label: rootLabel(root.physical),
        read: true,
        write: this.writeRoots.some((candidate) => candidate.id === root.id),
      });
    }
    for (const root of this.writeRoots) {
      const existing = roots.get(root.id);
      roots.set(root.id, {
        id: root.id,
        label: existing?.label ?? rootLabel(root.physical),
        read: existing?.read ?? false,
        write: true,
      });
    }
    return [...roots.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  /** Resolve a root-relative read without ever treating the alias as new authority. */
  public async authorizeRootRead(rootId: string, workspacePath: string): Promise<string> {
    const root = this.readRoots.find((candidate) => candidate.id === rootId);
    if (!root) throw new Error('Unknown or unreadable MCP root');
    const candidate = path.join(root.physical, ...parseRootRelativePath(workspacePath));
    const physical = await realpath(candidate).catch(() => null);
    if (!physical || !isPathInside(root.physical, physical)) {
      throw new Error('MCP read path is outside the selected root');
    }
    return this.authorizeRead(physical);
  }

  /** Resolve a root-relative write without ever treating the alias as new authority. */
  public async authorizeRootWrite(rootId: string, workspacePath: string): Promise<string> {
    const root = this.writeRoots.find((candidate) => candidate.id === rootId);
    if (!root) throw new Error('Unknown or unwritable MCP root');
    const candidate = path.join(root.physical, ...parseRootRelativePath(workspacePath));
    const authorized = await this.authorizeWrite(candidate);
    const physicalParent = await realpath(path.dirname(authorized));
    if (!isPathInside(root.physical, physicalParent)) {
      throw new Error('MCP write path is outside the selected root');
    }
    return authorized;
  }

  public async readFile(requestedPath: string, signal?: AbortSignal): Promise<Buffer> {
    signal?.throwIfAborted();
    const physical = await this.authorizeRead(requestedPath);
    signal?.throwIfAborted();
    const root = this.readRoots.find((candidate) => isPathInside(candidate.physical, physical));
    if (!root) throw new Error('MCP read path is outside the configured roots');
    return readContainedFile(root.physical, physical, this.maxInputFileBytes, {
      signal,
      afterReadChunk: this.dependencies.afterInputReadChunk,
    });
  }

  public async authorizeWrite(requestedPath: string): Promise<string> {
    const candidate = validatePath(requestedPath);
    const filename = path.basename(candidate);
    validatePortableFilename(filename);
    const existing = await lstat(candidate).catch(() => null);
    if (existing?.isSymbolicLink()) {
      throw new Error('MCP output cannot replace a symbolic link or junction');
    }
    if (existing && !existing.isFile()) {
      throw new Error('MCP output target must be a regular file');
    }

    const nearest = await nearestExistingPath(existing ? candidate : path.dirname(candidate));
    const physicalTarget = existing ? await realpath(candidate) : null;
    const physicalParent = physicalTarget ? path.dirname(physicalTarget) : await realpath(nearest);
    if (!this.writeRoots.some((root) => isPathInside(root.physical, physicalParent))) {
      throw new Error('MCP write path is outside the configured roots');
    }

    // Preserve the caller's exact filename while anchoring it below the
    // physically authorized parent. Missing nested parents are intentionally
    // rejected; converters should not create arbitrary directory trees.
    if (!existing && !samePath(nearest, path.dirname(candidate))) {
      throw new Error('MCP output parent directory does not exist');
    }
    return physicalTarget ?? path.join(physicalParent, filename);
  }

  /** Publish bounded bytes through an operation-owned sibling file. */
  public async materializeBytes(
    requestedPath: string,
    content: Uint8Array,
    maximumBytes: number,
    options: McpMaterializationOptions = {},
  ): Promise<string> {
    const signal = options.signal;
    signal?.throwIfAborted();
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 0 ||
      content.byteLength > maximumBytes
    ) {
      throw new Error('MCP binary output exceeds the configured limit');
    }
    const ifExists = options.ifExists ?? 'error';
    if (ifExists !== 'error' && ifExists !== 'replace') {
      throw new Error('Invalid MCP materialization mode');
    }
    const expectedSha256 = options.expectedSha256?.toLowerCase();
    if (expectedSha256 && !/^[a-f0-9]{64}$/u.test(expectedSha256)) {
      throw new Error('Invalid expected SHA-256');
    }
    if (ifExists === 'replace' && !expectedSha256) {
      throw new Error('MCP replacement requires an expected SHA-256');
    }
    if (ifExists === 'error' && expectedSha256) {
      throw new Error('MCP no-replace publication cannot include an expected SHA-256');
    }

    const initialTarget = await this.authorizeWrite(requestedPath);
    return withMaterializationLock(initialTarget, async () => {
      signal?.throwIfAborted();
      const target = await this.authorizeWrite(requestedPath);
      if (!samePath(initialTarget, target)) {
        throw new Error('MCP output changed physical identity before materialization');
      }
      const parentIdentity = await readMaterializationParentIdentity(target, this.writeRoots);
      const current = await lstat(target).catch(() => null);
      if (current?.isSymbolicLink()) throw new Error('MCP output cannot replace a symbolic link');
      if (ifExists === 'error' && current) throw new Error('MCP output already exists');
      if (expectedSha256) {
        if (!current?.isFile()) throw new Error('MCP output hash precondition failed');
        const actual = await hashFileBounded(
          target,
          this.maxInputFileBytes,
          signal,
          this.dependencies.afterMaterializationHashChunk,
        );
        if (actual !== expectedSha256) throw new Error('MCP output hash precondition failed');
      }

      const temporary = path.join(
        path.dirname(target),
        `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
      );
      let handle: Awaited<ReturnType<typeof open>> | null = null;
      try {
        signal?.throwIfAborted();
        handle = await open(temporary, 'wx');
        await writeFileHandle(
          handle,
          content,
          signal,
          this.dependencies.afterMaterializationWriteChunk,
        );
        signal?.throwIfAborted();
        await handle.sync();
        await handle.close();
        handle = null;
        await this.dependencies.afterMaterializationStage?.(temporary);
        signal?.throwIfAborted();
        if (expectedSha256) {
          // Staging can be expensive. Revalidate after it completes so a
          // writer that changed the target during staging is never silently
          // overwritten by this process.
          const actual = await hashFileBounded(
            target,
            this.maxInputFileBytes,
            signal,
            this.dependencies.afterMaterializationHashChunk,
          );
          if (actual !== expectedSha256) throw new Error('MCP output hash precondition failed');
        }
        signal?.throwIfAborted();
        await assertMaterializationParentIdentity(target, parentIdentity, this.writeRoots);
        if (ifExists === 'error') {
          // Hard-link publication is an atomic create-if-absent operation on the
          // same filesystem. The operation-owned temporary is removed below.
          await this.publishCreateIfAbsent(temporary, target, content, signal);
        } else {
          // Node exposes atomic replacement but not a cross-platform atomic
          // compare-and-swap primitive. The process lock and post-stage hash
          // recheck provide process-strong conditional replacement; the wire
          // contract deliberately does not claim storage-atomic strength.
          await rename(temporary, target);
        }
        notifyMaterializationPublished(this.dependencies.afterMaterializationPublish, target);
        return target;
      } finally {
        await handle?.close().catch(() => undefined);
        await unlink(temporary).catch(() => undefined);
      }
    });
  }

  /**
   * Publish the staged bytes only if nothing occupies the target.
   *
   * A hard link is the preferred primitive: it makes an already-complete,
   * fsynced file appear at the target in one atomic step. FAT32/exFAT and some
   * SMB mounts cannot create hard links at all, which would otherwise fail
   * every no-replace publication on those volumes even though the write is
   * legal. `open(target, 'wx')` is the same atomic create-if-absent primitive
   * without hard links — the kernel still refuses an occupied name with EEXIST,
   * so an existing file is never replaced and the no-replace contract holds.
   *
   * The fallback is strictly weaker in one respect: the target is created
   * before its bytes land, so a concurrent reader can observe a short file.
   * That window is unavoidable on a filesystem offering no link primitive, and
   * it never costs a caller their data. The caller's TOCTOU protections are
   * untouched: the parent identity is revalidated before this runs.
   */
  private async publishCreateIfAbsent(
    temporary: string,
    target: string,
    content: Uint8Array,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const linkFile = this.dependencies.link ?? link;
    try {
      await linkFile(temporary, target);
      return;
    } catch (error: unknown) {
      // A genuinely occupied target must refuse, never fall back.
      if (isNodeErrorCode(error, 'EEXIST')) throw new Error('MCP output already exists');
      if (!isLinkUnsupportedError(error)) throw error;
    }

    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(target, 'wx');
    } catch (error: unknown) {
      if (isNodeErrorCode(error, 'EEXIST')) throw new Error('MCP output already exists');
      throw error;
    }
    try {
      await writeFileHandle(
        handle,
        content,
        signal,
        this.dependencies.afterMaterializationWriteChunk,
      );
      signal?.throwIfAborted();
      await handle.sync();
      await handle.close();
    } catch (error: unknown) {
      // This process exclusively created the target, so removing the partial
      // publication cannot destroy another writer's file.
      await handle.close().catch(() => undefined);
      await unlink(target).catch(() => undefined);
      throw error;
    }
  }
}

async function resolveRoots(values: readonly string[]): Promise<PhysicalRoot[]> {
  const roots: PhysicalRoot[] = [];
  for (const value of values) {
    const lexical = validatePath(value);
    const physical = await realpath(lexical);
    const info = await stat(physical);
    if (!info.isDirectory()) throw new Error(`MCP authority root is not a directory: ${value}`);
    if (!roots.some((root) => samePath(root.physical, physical))) {
      roots.push({ id: rootIdFor(physical), lexical, physical });
    }
  }
  return roots;
}

function rootIdFor(physicalPath: string): string {
  const normalized = process.platform === 'win32' ? physicalPath.toLowerCase() : physicalPath;
  return `root-${createHash('sha256').update(normalized).digest('hex').slice(0, 16)}`;
}

function rootLabel(physicalPath: string): string {
  const candidate = path.basename(physicalPath) || 'root';
  let label = '';
  for (const character of candidate) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 0 || codePoint === 0x7f) continue;
    if (label.length + character.length > MCP_WIRE_LIMITS.labelCharacters) break;
    label += character;
  }
  return label || 'root';
}

function parseRootRelativePath(value: string): string[] {
  if (
    !value ||
    value.length > MAX_PATH_CHARACTERS ||
    value.includes('\0') ||
    value.includes('\\') ||
    path.posix.isAbsolute(value) ||
    /^[a-zA-Z]:/u.test(value)
  ) {
    throw new Error('Invalid MCP root-relative path');
  }
  const segments = value.split('/');
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        [...segment].some((character) => (character.codePointAt(0) ?? 0) <= 0x1f),
    )
  ) {
    throw new Error('Invalid MCP root-relative path');
  }
  return segments;
}

async function nearestExistingPath(candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) throw new Error('MCP output has no accessible parent directory');
      current = parent;
    }
  }
}

function validatePath(value: string): string {
  if (!value || value.length > MAX_PATH_CHARACTERS || value.includes('\0')) {
    throw new Error('Invalid MCP filesystem path');
  }
  return path.resolve(value);
}

function validatePortableFilename(value: string): void {
  const stem = value.split('.', 1)[0]?.toLowerCase() ?? '';
  if (
    !value ||
    hasUnsafeFilenameCharacter(value) ||
    /[ .]$/u.test(value) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u.test(stem)
  ) {
    throw new Error('MCP output filename is not portable or safe');
  }
}

function hasUnsafeFilenameCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || '<>:"/\\|?*'.includes(character)) return true;
  }
  return false;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

async function writeFileHandle(
  handle: Awaited<ReturnType<typeof open>>,
  content: Uint8Array,
  signal?: AbortSignal,
  afterChunk?: (writtenBytes: number, totalBytes: number) => Promise<void> | void,
): Promise<void> {
  const bytes = Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  let offset = 0;
  while (offset < bytes.byteLength) {
    signal?.throwIfAborted();
    const length = Math.min(MATERIALIZATION_WRITE_CHUNK_BYTES, bytes.byteLength - offset);
    const { bytesWritten } = await handle.write(bytes, offset, length, null);
    if (bytesWritten < 1) throw new Error('MCP materialization write made no progress');
    offset += bytesWritten;
    await afterChunk?.(offset, bytes.byteLength);
    signal?.throwIfAborted();
  }
  signal?.throwIfAborted();
}

async function hashFileBounded(
  filePath: string,
  maximumBytes: number,
  signal?: AbortSignal,
  afterChunk?: (readBytes: number, totalBytes: number) => Promise<void> | void,
): Promise<string> {
  signal?.throwIfAborted();
  const lexical = await lstat(filePath).catch(() => null);
  if (!lexical?.isFile() || lexical.isSymbolicLink()) {
    throw new Error('MCP output hash precondition failed');
  }
  if (lexical.size > maximumBytes) {
    throw new Error('MCP output hash precondition exceeds the configured file-size limit');
  }

  const handle = await open(filePath, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximumBytes) {
      throw new Error('MCP output hash precondition exceeds the configured file-size limit');
    }
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(HASH_READ_CHUNK_BYTES);
    let position = 0;
    while (position < before.size) {
      signal?.throwIfAborted();
      const length = Math.min(buffer.byteLength, before.size - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead < 1) throw new Error('MCP output changed while checking its hash');
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
      await afterChunk?.(position, before.size);
      signal?.throwIfAborted();
    }
    signal?.throwIfAborted();
    const after = await handle.stat();
    const current = await lstat(filePath).catch(() => null);
    if (
      !current?.isFile() ||
      current.isSymbolicLink() ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      current.dev !== after.dev ||
      current.ino !== after.ino
    ) {
      throw new Error('MCP output changed while checking its hash');
    }
    return digest.digest('hex');
  } finally {
    await handle.close();
  }
}

async function readMaterializationParentIdentity(
  target: string,
  writeRoots: readonly PhysicalRoot[],
): Promise<MaterializationParentIdentity> {
  const parent = path.dirname(target);
  let lexical: Awaited<ReturnType<typeof lstat>>;
  let physical: string;
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    [lexical, physical] = await Promise.all([lstat(parent), realpath(parent)]);
    info = await stat(physical);
  } catch {
    throw new Error('MCP output parent cannot be physically revalidated');
  }
  if (lexical.isSymbolicLink() || !lexical.isDirectory() || !info.isDirectory()) {
    throw new Error('MCP output parent changed physical identity before publication');
  }
  if (!writeRoots.some((root) => isPathInside(root.physical, physical))) {
    throw new Error('MCP output parent escaped the configured write roots before publication');
  }
  return { physical, dev: info.dev, ino: info.ino };
}

async function assertMaterializationParentIdentity(
  target: string,
  expected: MaterializationParentIdentity,
  writeRoots: readonly PhysicalRoot[],
): Promise<void> {
  const current = await readMaterializationParentIdentity(target, writeRoots);
  if (
    !samePath(current.physical, expected.physical) ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino
  ) {
    throw new Error('MCP output parent changed physical identity before publication');
  }
}

function notifyMaterializationPublished(
  callback: McpFileAuthorityDependencies['afterMaterializationPublish'],
  target: string,
): void {
  try {
    callback?.(target);
  } catch {
    // Publication is the commit boundary. No observer failure may turn a
    // successfully published file into a reported operation failure.
  }
}

async function withMaterializationLock<T>(target: string, operation: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? target.toLowerCase() : target;
  const previous = materializationTails.get(key) ?? Promise.resolve();
  const run = previous.then(operation, operation);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  materializationTails.set(key, tail);
  try {
    return await run;
  } finally {
    if (materializationTails.get(key) === tail) materializationTails.delete(key);
  }
}
