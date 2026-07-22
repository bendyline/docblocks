import fs from 'node:fs/promises';
import path from 'node:path';

export interface ExportReplacementDetails {
  filename: string;
  displayPath: string;
}

export type ConfirmExportReplacement = (details: ExportReplacementDetails) => Promise<boolean>;

/**
 * Capture enough filesystem identity to recognize the exact file approved by
 * a native Save dialog without reading the whole export target into memory.
 */
export async function readExportTargetIdentity(targetPath: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(targetPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('Export target must be a regular file or a new file');
    }
    return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
  } catch (error: unknown) {
    if (isNodeErrorCode(error, 'ENOENT')) return null;
    throw error;
  }
}

/**
 * Confirm replacement unless the target is new or is still the exact file
 * whose replacement the native Save dialog already approved.
 */
export async function confirmExportReplacement(
  targetPath: string,
  pickerApprovedIdentity: string | null,
  confirm: ConfirmExportReplacement,
): Promise<boolean> {
  const currentIdentity = await readExportTargetIdentity(targetPath);
  if (currentIdentity === null || currentIdentity === pickerApprovedIdentity) return true;
  return confirm({ filename: path.basename(targetPath), displayPath: targetPath });
}

function isNodeErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
