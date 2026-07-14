import fs from 'node:fs/promises';
import path from 'node:path';

const CONTAINED_READ_CHUNK_BYTES = 64 * 1024;

export interface ContainedFileReadOptions {
  signal?: AbortSignal;
  /** Test seam after each bounded read chunk, before cancellation is rechecked. */
  afterReadChunk?(readBytes: number, totalBytes: number): Promise<void> | void;
}

/** Read one regular file only after physical containment and descriptor identity checks. */
export async function readContainedFile(
  rootPath: string,
  candidatePath: string,
  maximumBytes: number,
  options: ContainedFileReadOptions = {},
): Promise<Buffer> {
  const { signal, afterReadChunk } = options;
  signal?.throwIfAborted();
  const physicalRoot = await fs.realpath(path.resolve(rootPath));
  signal?.throwIfAborted();
  const physicalCandidate = await fs.realpath(path.resolve(candidatePath));
  signal?.throwIfAborted();
  if (!isPathInside(physicalRoot, physicalCandidate)) {
    throw new Error('File is outside the authorized root');
  }

  const handle = await fs.open(physicalCandidate, 'r');
  try {
    signal?.throwIfAborted();
    const before = await handle.stat();
    signal?.throwIfAborted();
    if (!before.isFile() || before.size > maximumBytes) {
      throw new Error('File exceeds the configured size limit');
    }
    await assertIdentity(physicalRoot, physicalCandidate, before, signal);
    signal?.throwIfAborted();

    const result = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < result.length) {
      signal?.throwIfAborted();
      const length = Math.min(CONTAINED_READ_CHUNK_BYTES, result.length - offset);
      const { bytesRead } = await handle.read(result, offset, length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      await afterReadChunk?.(offset, result.length);
      signal?.throwIfAborted();
    }
    signal?.throwIfAborted();
    const extra = Buffer.alloc(1);
    if ((await handle.read(extra, 0, 1, offset)).bytesRead > 0) {
      throw new Error('File grew beyond the configured size limit');
    }
    signal?.throwIfAborted();

    const after = await handle.stat();
    signal?.throwIfAborted();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new Error('File changed while it was being read');
    }
    await assertIdentity(physicalRoot, physicalCandidate, after, signal);
    signal?.throwIfAborted();
    return result.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function assertIdentity(
  physicalRoot: string,
  candidatePath: string,
  descriptorStat: Awaited<ReturnType<fs.FileHandle['stat']>>,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const physicalCandidate = await fs.realpath(candidatePath);
  signal?.throwIfAborted();
  if (!isPathInside(physicalRoot, physicalCandidate)) {
    throw new Error('File escaped the authorized root while it was being read');
  }
  const pathStat = await fs.stat(physicalCandidate);
  signal?.throwIfAborted();
  if (descriptorStat.dev !== pathStat.dev || descriptorStat.ino !== pathStat.ino) {
    throw new Error('File changed physical identity while it was being read');
  }
}

function isPathInside(rootAbs: string, candidateAbs: string): boolean {
  const relative = path.relative(path.resolve(rootAbs), path.resolve(candidateAbs));
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}
