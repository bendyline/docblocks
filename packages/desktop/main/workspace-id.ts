import { createHash } from 'node:crypto';
import path from 'node:path';

/** Stable, collision-resistant id for a main-authorized physical workspace. */
export function deriveWorkspaceId(rootPath: string): string {
  const resolved = path.resolve(rootPath);
  const normalized = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const base = path.basename(resolved) || 'workspace';
  const safeBase = base.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  return `electron-${safeBase || 'workspace'}-${digest}`;
}
