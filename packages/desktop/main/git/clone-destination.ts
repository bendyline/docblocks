import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export class CloneDestinationExistsError extends Error {
  public constructor(public readonly targetDir: string) {
    super(`Clone destination already exists: ${targetDir}`);
    this.name = 'CloneDestinationExistsError';
  }
}

export interface CloneDestinationOptions {
  /** Deterministic adversarial-race hook used only by filesystem tests. */
  readonly beforePublish?: (targetDir: string) => Promise<void>;
}

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function sameIdentity(stat: Awaited<ReturnType<typeof fs.lstat>>, identity: DirectoryIdentity) {
  return stat.dev === identity.dev && stat.ino === identity.ino;
}

async function copyTreeNoReplace(source: string, destination: string): Promise<void> {
  const entries = await fs.readdir(source, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(destinationPath);
      await copyTreeNoReplace(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      await fs.copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL);
    } else if (entry.isSymbolicLink()) {
      await fs.symlink(await fs.readlink(sourcePath), destinationPath);
    } else {
      throw new Error(`Unsupported entry in cloned repository: ${entry.name}`);
    }
  }
}

/**
 * Operation-owned staging plus an atomically exclusive final-directory
 * reservation. Node has no portable rename-no-replace primitive for
 * directories (POSIX rename may replace an empty directory), so publication
 * copies into the reserved directory using mkdir/COPYFILE_EXCL/symlink. No
 * destination entry is overwritten, and cleanup recursively owns only the
 * hidden staging tree.
 */
export class CloneDestination {
  public readonly parentDir: string;
  public readonly targetDir: string;
  public readonly stagingRoot: string;
  public readonly stagingDir: string;
  private readonly targetIdentity: DirectoryIdentity;
  private readonly beforePublish?: (targetDir: string) => Promise<void>;
  private promotionAttempted = false;
  private promoted = false;
  private cleanupPromise: Promise<void> | null = null;

  private constructor(
    parentDir: string,
    targetDir: string,
    stagingRoot: string,
    targetIdentity: DirectoryIdentity,
    options: CloneDestinationOptions,
  ) {
    this.parentDir = parentDir;
    this.targetDir = targetDir;
    this.stagingRoot = stagingRoot;
    this.stagingDir = path.join(stagingRoot, 'checkout');
    this.targetIdentity = targetIdentity;
    this.beforePublish = options.beforePublish;
  }

  public static async create(
    parentDir: string,
    targetName: string,
    options: CloneDestinationOptions = {},
  ): Promise<CloneDestination> {
    const physicalParent = await fs.realpath(parentDir);
    if (!(await fs.stat(physicalParent)).isDirectory()) {
      throw new Error('Clone parent is not a regular directory.');
    }
    const targetDir = path.join(physicalParent, targetName);
    if (path.dirname(targetDir) !== physicalParent || targetDir === physicalParent) {
      throw new Error('Clone target escapes the selected directory.');
    }
    try {
      await fs.mkdir(targetDir);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new CloneDestinationExistsError(targetDir);
      }
      throw error;
    }
    const targetStat = await fs.lstat(targetDir);
    const targetIdentity = { dev: targetStat.dev, ino: targetStat.ino };
    try {
      const stagingRoot = await fs.mkdtemp(path.join(physicalParent, '.docblocks-clone-'));
      return new CloneDestination(physicalParent, targetDir, stagingRoot, targetIdentity, options);
    } catch (error: unknown) {
      // The reservation is ours only while its filesystem identity still
      // matches. A concurrent remove/recreate must never let setup cleanup
      // delete somebody else's empty directory.
      try {
        const current = await fs.lstat(targetDir);
        if (sameIdentity(current, targetIdentity)) await fs.rmdir(targetDir);
      } catch {
        // Setup failure is authoritative; cleanup remains best effort and
        // deliberately non-recursive.
      }
      throw error;
    }
  }

  public async promote(): Promise<string> {
    if (this.promoted) return fs.realpath(this.targetDir);
    if (this.promotionAttempted) throw new Error('Clone publication has already been attempted.');
    this.promotionAttempted = true;

    const physicalStagingRoot = await fs.realpath(this.stagingRoot);
    const physicalCheckout = await fs.realpath(this.stagingDir);
    const checkoutStat = await fs.lstat(this.stagingDir);
    if (
      !checkoutStat.isDirectory() ||
      checkoutStat.isSymbolicLink() ||
      !isInside(physicalStagingRoot, physicalCheckout)
    ) {
      throw new Error('Clone checkout escaped its operation-owned staging directory.');
    }

    await this.beforePublish?.(this.targetDir);
    const reservation = await fs.lstat(this.targetDir);
    if (
      !reservation.isDirectory() ||
      reservation.isSymbolicLink() ||
      !sameIdentity(reservation, this.targetIdentity) ||
      (await fs.readdir(this.targetDir)).length !== 0
    ) {
      throw new CloneDestinationExistsError(this.targetDir);
    }

    try {
      await copyTreeNoReplace(this.stagingDir, this.targetDir);
      const publishedStat = await fs.lstat(this.targetDir);
      const physicalTarget = await fs.realpath(this.targetDir);
      if (
        !sameIdentity(publishedStat, this.targetIdentity) ||
        !isInside(this.parentDir, physicalTarget) ||
        !publishedStat.isDirectory() ||
        publishedStat.isSymbolicLink()
      ) {
        throw new Error('Published clone target changed physical identity.');
      }
      this.promoted = true;
      return physicalTarget;
    } finally {
      await this.cleanup().catch(() => undefined);
    }
  }

  public cleanup(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = (async () => {
      await fs.rm(this.stagingRoot, { recursive: true, force: true });
      if (this.promoted) return;
      try {
        const targetStat = await fs.lstat(this.targetDir);
        if (sameIdentity(targetStat, this.targetIdentity)) await fs.rmdir(this.targetDir);
      } catch {
        // Never recursively clean the final target. rmdir removes only our
        // still-empty reservation; concurrent user data makes it fail closed.
      }
    })();
    return this.cleanupPromise;
  }
}
