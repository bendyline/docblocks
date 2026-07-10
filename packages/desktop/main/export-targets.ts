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

  const last = validAccess(stored?.last);
  if (last) return path.join(path.dirname(path.resolve(last.path)), safeFilename);

  return path.join(path.resolve(downloadsDirectory), safeFilename);
}

export function resolveRequestedExportTarget(fallbackTarget: string, value: string | null): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return path.resolve(fallbackTarget);
  if (path.isAbsolute(trimmed)) return path.resolve(trimmed);
  return path.join(path.dirname(path.resolve(fallbackTarget)), sanitizeExportFilename(trimmed));
}

export function findExportTargetAccess(
  stored: PersistedExportTarget | undefined,
  targetPath: string,
): PersistedExportTargetAccess | null {
  const target = comparisonPath(targetPath);
  return allAccesses(stored).find((access) => comparisonPath(access.path) === target) ?? null;
}

export function isInRememberedExportDirectory(
  stored: PersistedExportTarget | undefined,
  targetPath: string,
): boolean {
  return allAccesses(stored).some((access) =>
    isInExportDirectory(path.dirname(access.path), targetPath),
  );
}

export function isInExportDirectory(directory: string, targetPath: string): boolean {
  return (
    comparisonPath(path.dirname(path.resolve(targetPath))) ===
    comparisonPath(path.resolve(directory))
  );
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
  if (!value || typeof value.path !== 'string' || !path.isAbsolute(value.path)) return null;
  if (!value.path.trim() || value.path.includes('\0')) return null;
  return value;
}

function comparisonPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
