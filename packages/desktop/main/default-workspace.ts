import fs from 'node:fs/promises';
import path from 'node:path';

export function sameWorkspacePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

/**
 * Recreate the app-managed default when it was removed outside DocBlocks.
 * Other persisted workspaces are user-owned and must not be silently created.
 */
export async function ensurePersistedDefaultWorkspace(
  workspaceRoot: string,
  defaultWorkspaceRoot: string | undefined,
): Promise<void> {
  if (!defaultWorkspaceRoot || !sameWorkspacePath(workspaceRoot, defaultWorkspaceRoot)) return;
  await fs.mkdir(workspaceRoot, { recursive: true });
}
