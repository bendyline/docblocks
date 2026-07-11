/**
 * Pure helpers for resolving and validating native export targets.
 * Electron IPC and unit tests both use this module.
 */

import path from 'node:path';
import type { PersistedExportTarget, PersistedExportTargetAccess } from './settings.js';

export function sanitizeExportFilename(filename: string): string {
  const basename = path.basename(filename.replace(/\\/g, '/'));
  const clean = basename
    .replaceAll('\0', '-')
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/[. ]+$/, '')
    .trim();
  return clean || 'document';
}

export function getExportExtension(filename: string): string | null {
  const extension = path.extname(filename).slice(1).toLowerCase();
  return extension || null;
}

export function resolveExportTarget(
  downloadsDirectory: string,
  stored: PersistedExportTarget | undefined,
  filename: string,
): string {
  const safeFilename = sanitizeExportFilename(filename);
  const extension = getExportExtension(safeFilename);
  const exact = extension ? validAccess(stored?.byExtension?.[extension]) : null;
  if (exact) return path.resolve(exact.path);
  // A file picker grants one exact target, not ambient write authority to its
  // parent directory. New output types therefore return to the host-owned
  // Downloads default until the user chooses another exact file.
  return path.join(path.resolve(downloadsDirectory), safeFilename);
}

export function findExportTargetAccess(
  stored: PersistedExportTarget | undefined,
  targetPath: string,
): PersistedExportTargetAccess | null {
  const target = comparisonPath(targetPath);
  return allAccesses(stored).find((access) => comparisonPath(access.path) === target) ?? null;
}

function allAccesses(stored: PersistedExportTarget | undefined): PersistedExportTargetAccess[] {
  const accesses: PersistedExportTargetAccess[] = [];
  const last = validAccess(stored?.last);
  if (last) accesses.push(last);
  for (const access of Object.values(stored?.byExtension ?? {})) {
    const valid = validAccess(access);
    if (valid) accesses.push(valid);
  }
  return accesses;
}

function validAccess(
  value: PersistedExportTargetAccess | undefined,
): PersistedExportTargetAccess | null {
  if (
    !value ||
    value.confirmedByPicker !== true ||
    typeof value.path !== 'string' ||
    !path.isAbsolute(value.path)
  ) {
    return null;
  }
  if (!value.path.trim() || value.path.includes('\0')) return null;
  return value;
}

function comparisonPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
