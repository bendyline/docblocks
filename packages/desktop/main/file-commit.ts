import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileCommitResult } from '@bendyline/docblocks/filesystem';
import type { ExternalBinaryCommitResult } from '@bendyline/docblocks/host';

const mutationTails = new Map<string, Promise<void>>();

async function withMutationLock<T>(absolutePath: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(absolutePath);
  const previous = mutationTails.get(key) ?? Promise.resolve();
  const run = previous.then(operation, operation);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  mutationTails.set(key, tail);
  try {
    return await run;
  } finally {
    if (mutationTails.get(key) === tail) mutationTails.delete(key);
  }
}

export async function withFileMutationLocks<T>(
  absolutePaths: string[],
  operation: () => Promise<T>,
): Promise<T> {
  const keys = [...new Set(absolutePaths.map((item) => path.resolve(item)))].sort();
  const acquire = (index: number): Promise<T> =>
    index >= keys.length ? operation() : withMutationLock(keys[index], () => acquire(index + 1));
  return acquire(0);
}

export async function readTextOrNull(absolutePath: string): Promise<string | null> {
  try {
    return await fs.readFile(absolutePath, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function readBinaryOrNull(absolutePath: string): Promise<Uint8Array | null> {
  try {
    const data = await fs.readFile(absolutePath);
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    return copy;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function atomicWriteText(absolutePath: string, content: string): Promise<void> {
  await atomicWrite(absolutePath, content);
}

export async function atomicWriteBinary(
  absolutePath: string,
  content: ArrayBuffer | Uint8Array,
): Promise<void> {
  const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
  await atomicWrite(absolutePath, bytes);
}

async function atomicWrite(absolutePath: string, content: string | Uint8Array): Promise<void> {
  const directory = path.dirname(absolutePath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(absolutePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(temporaryPath, 'wx');
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, absolutePath);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporaryPath).catch(() => undefined);
  }
}

export async function fileSha256OrNull(absolutePath: string): Promise<string | null> {
  try {
    return sha256(await fs.readFile(absolutePath));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

export function commitTextFile(
  absolutePath: string | (() => Promise<string>),
  content: string,
  expectedContent: string | null,
  lockPaths: string[] = typeof absolutePath === 'string' ? [absolutePath] : [],
): Promise<FileCommitResult> {
  return withFileMutationLocks(lockPaths, async () => {
    const resolvePath = async (): Promise<string> =>
      path.resolve(typeof absolutePath === 'string' ? absolutePath : await absolutePath());
    const observedPath = await resolvePath();
    const current = await readTextOrNull(observedPath);
    if (current !== expectedContent && current !== content) {
      const verifiedPath = await resolvePath();
      if (verifiedPath !== observedPath) {
        throw new Error('Commit target changed physical identity while checking for conflict.');
      }
      return {
        status: 'conflict',
        content: current,
        version: await fileSha256OrNull(observedPath),
      };
    }
    const writePath = await resolvePath();
    if (writePath !== observedPath) {
      throw new Error('Commit target changed physical identity before mutation.');
    }
    await atomicWriteText(writePath, content);
    const committedPath = await resolvePath();
    if (committedPath !== writePath) {
      throw new Error('Commit target changed physical identity after mutation.');
    }
    return { status: 'committed', version: await fileSha256OrNull(writePath) };
  });
}

export function commitBinaryFile(
  absolutePath: string,
  data: ArrayBuffer | Uint8Array,
  expectedVersion: string | null,
  lockPaths: string[] = [absolutePath],
): Promise<ExternalBinaryCommitResult> {
  return withFileMutationLocks(lockPaths, async () => {
    const currentData = await readBinaryOrNull(absolutePath);
    const currentVersion = currentData ? sha256(currentData) : null;
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const nextVersion = sha256(bytes);
    if (currentVersion !== expectedVersion && currentVersion !== nextVersion) {
      return {
        status: 'conflict',
        version: currentVersion,
        data: (currentData?.buffer as ArrayBuffer | undefined) ?? null,
      };
    }
    await atomicWriteBinary(absolutePath, bytes);
    return { status: 'committed', version: nextVersion };
  });
}
