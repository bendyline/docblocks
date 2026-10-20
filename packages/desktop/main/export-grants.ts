import fs from 'node:fs/promises';
import path from 'node:path';

import { OwnerGrantStore } from './owner-grants.js';
import { readExportTargetIdentity } from './export-overwrite.js';

interface ExportTargetResource {
  documentKey: string;
  absolutePath: string;
  physicalParent: string;
  bookmark?: string;
  pickerApprovedIdentity?: string;
  savedIdentity?: string;
}

export interface ResolvedExportTarget {
  absolutePath: string;
  bookmark?: string;
}

const grants = new OwnerGrantStore<ExportTargetResource>('export');

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function assertRegularOrMissing(absolutePath: string): Promise<void> {
  try {
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('Export target must be a regular file or a new file');
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function mintExportGrant(
  ownerId: number,
  documentKey: string,
  targetPath: string,
  bookmark?: string,
  pickerApprovedIdentity?: string,
): Promise<{ grantId: string; displayPath: string }> {
  const requested = path.resolve(targetPath);
  const physicalParent = await fs.realpath(path.dirname(requested));
  const absolutePath = path.join(physicalParent, path.basename(requested));
  await assertRegularOrMissing(absolutePath);
  const grantId = grants.mint(ownerId, {
    documentKey,
    absolutePath,
    physicalParent,
    bookmark,
    pickerApprovedIdentity,
  });
  return { grantId, displayPath: absolutePath };
}

/** A native picker approval applies to one save attempt only. */
export function consumeExportPickerApproval(ownerId: number, grantId: string): string | null {
  const resource = grants.require(ownerId, grantId);
  const identity = resource.pickerApprovedIdentity ?? null;
  resource.pickerApprovedIdentity = undefined;
  return identity;
}

export async function resolveExportGrant(
  ownerId: number,
  documentKey: string,
  grantId: string,
): Promise<ResolvedExportTarget> {
  const resource = grants.require(ownerId, grantId);
  if (resource.documentKey !== documentKey) {
    throw new Error('Export grant belongs to another document');
  }
  const currentParent = await fs.realpath(path.dirname(resource.absolutePath));
  if (pathKey(currentParent) !== pathKey(resource.physicalParent)) {
    grants.revoke(ownerId, grantId);
    throw new Error('Export target parent changed after it was granted');
  }
  await assertRegularOrMissing(resource.absolutePath);
  return { absolutePath: resource.absolutePath, bookmark: resource.bookmark };
}

export function revokeExportOwner(ownerId: number): void {
  grants.revokeOwner(ownerId);
}

/** Only a completed write authorizes opening an export. A picker alone does not. */
export async function markExportSaved(
  ownerId: number,
  documentKey: string,
  grantId: string,
): Promise<void> {
  const target = await resolveExportGrant(ownerId, documentKey, grantId);
  const identity = await readExportTargetIdentity(target.absolutePath);
  if (!identity) throw new Error('The saved export is no longer available');
  grants.require(ownerId, grantId).savedIdentity = identity;
}

export async function resolveSavedExportGrant(
  ownerId: number,
  documentKey: string,
  grantId: string,
): Promise<ResolvedExportTarget> {
  const target = await resolveExportGrant(ownerId, documentKey, grantId);
  const savedIdentity = grants.require(ownerId, grantId).savedIdentity;
  if (!savedIdentity || savedIdentity !== (await readExportTargetIdentity(target.absolutePath))) {
    throw new Error('The export has not been saved or has changed since saving');
  }
  return target;
}
