import { lstat, open, realpath, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readContainedFile } from '../contained-file.js';

export interface McpFileAuthorityOptions {
  readRoots?: readonly string[];
  writeRoots?: readonly string[];
  maxInputFileBytes?: number;
}

const DEFAULT_MAX_INPUT_FILE_BYTES = 100 * 1024 * 1024;
const MAX_PATH_CHARACTERS = 4_096;

interface PhysicalRoot {
  lexical: string;
  physical: string;
}

/** Host-startup authority. Tool arguments can narrow it but can never expand it. */
export class McpFileAuthority {
  private constructor(
    private readonly readRoots: readonly PhysicalRoot[],
    private readonly writeRoots: readonly PhysicalRoot[],
    private readonly maxInputFileBytes: number,
  ) {}

  public static async create(options: McpFileAuthorityOptions = {}): Promise<McpFileAuthority> {
    const maxInputFileBytes = options.maxInputFileBytes ?? DEFAULT_MAX_INPUT_FILE_BYTES;
    if (!Number.isSafeInteger(maxInputFileBytes) || maxInputFileBytes < 1) {
      throw new Error('Invalid MCP input file limit');
    }
    return new McpFileAuthority(
      await resolveRoots(options.readRoots ?? []),
      await resolveRoots(options.writeRoots ?? []),
      maxInputFileBytes,
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

  public async readText(requestedPath: string): Promise<string> {
    return (await this.readFile(requestedPath)).toString('utf8');
  }

  public async readFile(requestedPath: string): Promise<Buffer> {
    const physical = await this.authorizeRead(requestedPath);
    const root = this.readRoots.find((candidate) => isPathInside(candidate.physical, physical));
    if (!root) throw new Error('MCP read path is outside the configured roots');
    return readContainedFile(root.physical, physical, this.maxInputFileBytes);
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

  public async writeText(
    requestedPath: string,
    content: string,
    maximumCharacters: number,
  ): Promise<string> {
    if (content.length > maximumCharacters || content.includes('\0')) {
      throw new Error('MCP text output exceeds the configured limit');
    }
    const target = await this.authorizeWrite(requestedPath);
    const current = await lstat(target).catch(() => null);
    if (current?.isSymbolicLink()) throw new Error('MCP output cannot replace a symbolic link');
    const temporary = path.join(
      path.dirname(target),
      `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(temporary, 'wx');
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, target);
      return target;
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
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
    if (!roots.some((root) => samePath(root.physical, physical))) roots.push({ lexical, physical });
  }
  return roots;
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

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}
