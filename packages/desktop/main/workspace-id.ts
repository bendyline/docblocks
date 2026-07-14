import { createHash } from 'node:crypto';
import path from 'node:path';

export interface WorkspaceIdentityRecord {
  readonly id: string;
  readonly rootPath: string;
}

function normalizedRoot(rootPath: string): string {
  const resolved = path.resolve(rootPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function idBase(rootPath: string): string {
  const base = path.basename(path.resolve(rootPath)) || 'workspace';
  return (
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 80) || 'workspace'
  );
}

function digest(rootPath: string): string {
  return createHash('sha256').update(normalizedRoot(rootPath)).digest('hex');
}

/** Stable, collision-resistant id for a main-authorized physical workspace. */
export function deriveWorkspaceId(rootPath: string): string {
  return `electron-${idBase(rootPath)}-${digest(rootPath).slice(0, 16)}`;
}

/**
 * Allocate the deterministic id, extending its digest if a corrupted or
 * manually-edited settings file already assigns that id to another root.
 */
export function allocateWorkspaceId(
  rootPath: string,
  existing: readonly WorkspaceIdentityRecord[],
): string {
  const root = normalizedRoot(rootPath);
  const hash = digest(rootPath);
  for (const length of [16, 24, 32, 48, 64]) {
    const candidate = `electron-${idBase(rootPath)}-${hash.slice(0, length)}`;
    const conflict = existing.some(
      (record) => record.id === candidate && normalizedRoot(record.rootPath) !== root,
    );
    if (!conflict) return candidate;
  }
  throw new Error('Could not allocate a unique workspace authority id.');
}

/**
 * Repair persisted descriptors before rebuilding the runtime authority map.
 * Unique legacy ids remain valid so upgrades do not orphan renderer-side
 * descriptors. Duplicate ids assigned to distinct roots are all migrated to
 * deterministic path-derived ids; duplicate records for one root collapse to
 * the most recently persisted descriptor.
 */
export function repairWorkspaceIdentities<T extends WorkspaceIdentityRecord>(
  records: readonly T[],
): { readonly records: T[]; readonly changed: boolean } {
  const byRoot = new Map<string, T>();
  for (const record of records) byRoot.set(normalizedRoot(record.rootPath), record);
  const deduplicated = [...byRoot.values()];

  const rootsById = new Map<string, Set<string>>();
  for (const record of deduplicated) {
    const roots = rootsById.get(record.id) ?? new Set<string>();
    roots.add(normalizedRoot(record.rootPath));
    rootsById.set(record.id, roots);
  }

  const repaired: T[] = [];
  for (const record of deduplicated) {
    if ((rootsById.get(record.id)?.size ?? 0) <= 1) {
      repaired.push(record);
      continue;
    }
    const id = allocateWorkspaceId(record.rootPath, [...deduplicated, ...repaired]);
    repaired.push({ ...record, id });
  }

  const changed =
    repaired.length !== records.length ||
    repaired.some((record, index) => {
      const previous = records[index];
      return (
        previous?.id !== record.id ||
        normalizedRoot(previous.rootPath) !== normalizedRoot(record.rootPath)
      );
    });
  return { records: repaired, changed };
}
