/**
 * Owner-scoped capabilities for individual files explicitly delivered by the
 * operating system (Open With / deep link). Absolute paths never cross into
 * the renderer; it receives only an opaque id bound to one WebContents.
 */

import fss from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDocumentMediaPath, tryParseWorkspacePath } from '@bendyline/docblocks/filesystem';

import { OwnerGrantStore } from './owner-grants.js';

interface ExternalResource {
  absolutePath: string;
  physicalParent: string;
  /** A loose markdown file may also read media inside its own folder. */
  relativeMedia: boolean;
}

export interface ExternalGrantOptions {
  readonly relativeMedia?: boolean;
}

const grants = new OwnerGrantStore<ExternalResource>('external');

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Mint exact-file authority for one renderer and return an opaque token. */
export function grantExternalPath(
  ownerId: number,
  absPath: string,
  options: ExternalGrantOptions = {},
): string {
  const physicalPath = fss.realpathSync.native(path.resolve(absPath));
  const stat = fss.lstatSync(physicalPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Only a regular external file can be granted');
  }
  const physicalParent = fss.realpathSync.native(path.dirname(physicalPath));
  return grants.mint(ownerId, {
    absolutePath: physicalPath,
    physicalParent,
    relativeMedia: options.relativeMedia === true,
  });
}

async function assertParentUnchanged(
  ownerId: number,
  resourceId: string,
  resource: ExternalResource,
): Promise<void> {
  const currentParent = await fs.realpath(path.dirname(resource.absolutePath));
  if (pathKey(currentParent) !== pathKey(resource.physicalParent)) {
    grants.revoke(ownerId, resourceId);
    throw new Error('External resource parent changed after it was granted');
  }
}

/** Resolve a token after proving that its canonical parent has not changed. */
export async function resolveExternalResource(
  ownerId: number,
  resourceId: string,
): Promise<string> {
  const resource = grants.require(ownerId, resourceId);
  await assertParentUnchanged(ownerId, resourceId, resource);

  try {
    const stat = await fs.lstat(resource.absolutePath);
    if (stat.isSymbolicLink()) {
      grants.revoke(ownerId, resourceId);
      throw new Error('External resource was replaced by a symbolic link');
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // A deleted exact file may be recreated by a later conditional commit;
    // the pinned physical parent still prevents an authority expansion.
  }

  return resource.absolutePath;
}

/**
 * Resolve a media file inside a loose markdown grant's folder, read-only.
 *
 * The path must already be a canonical workspace path (no `.`/`..`, no drive
 * or root) naming an image, audio, or video file, so it is lexically confined
 * to the pinned physical parent. The caller's read must still refuse symbolic
 * links, which is what keeps it physically confined too.
 */
export async function resolveExternalRelativeMedia(
  ownerId: number,
  resourceId: string,
  relativePath: string,
): Promise<string> {
  const resource = grants.require(ownerId, resourceId);
  if (!resource.relativeMedia) {
    throw new Error('External resource does not grant relative media');
  }
  if (
    tryParseWorkspacePath(relativePath) !== relativePath ||
    !relativePath ||
    !isDocumentMediaPath(relativePath) ||
    // An NTFS alternate data stream (`a.png:x`) is not a file in the folder.
    (process.platform === 'win32' && relativePath.includes(':'))
  ) {
    throw new Error('Invalid relative media path');
  }
  await assertParentUnchanged(ownerId, resourceId, resource);
  return path.join(resource.physicalParent, ...relativePath.split('/'));
}

export function revokeExternalResource(ownerId: number, resourceId: string): void {
  grants.revoke(ownerId, resourceId);
}

export function revokeExternalOwner(ownerId: number): void {
  grants.revokeOwner(ownerId);
}
