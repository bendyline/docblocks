import fs from 'node:fs/promises';
import path from 'node:path';

/** Read one regular file only after physical containment and descriptor identity checks. */
export async function readContainedFile(
  rootPath: string,
  candidatePath: string,
  maximumBytes: number,
): Promise<Buffer> {
  const physicalRoot = await fs.realpath(path.resolve(rootPath));
  const physicalCandidate = await fs.realpath(path.resolve(candidatePath));
  if (!isPathInside(physicalRoot, physicalCandidate)) {
    throw new Error('File is outside the authorized root');
  }

  const handle = await fs.open(physicalCandidate, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximumBytes) {
      throw new Error('File exceeds the configured size limit');
    }
    await assertIdentity(physicalRoot, physicalCandidate, before);

    const result = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < result.length) {
      const { bytesRead } = await handle.read(result, offset, result.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    if ((await handle.read(extra, 0, 1, offset)).bytesRead > 0) {
      throw new Error('File grew beyond the configured size limit');
    }

    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new Error('File changed while it was being read');
    }
    await assertIdentity(physicalRoot, physicalCandidate, after);
    return result.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function assertIdentity(
  physicalRoot: string,
  candidatePath: string,
  descriptorStat: Awaited<ReturnType<fs.FileHandle['stat']>>,
): Promise<void> {
  const physicalCandidate = await fs.realpath(candidatePath);
  if (!isPathInside(physicalRoot, physicalCandidate)) {
    throw new Error('File escaped the authorized root while it was being read');
  }
  const pathStat = await fs.stat(physicalCandidate);
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
