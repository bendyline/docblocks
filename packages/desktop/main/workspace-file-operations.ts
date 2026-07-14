import fs from 'node:fs/promises';

import { withFileMutationLocks } from './file-commit.js';
import type { WorkspaceRoots } from './workspace-roots.js';

/**
 * Remove an entry below a workspace root. Root deletion is rejected by the
 * same resolver used by every other native filesystem mutation.
 */
export async function deleteWorkspaceEntry(
  roots: WorkspaceRoots,
  rootPath: string,
  relativePath: string,
): Promise<void> {
  const rootAbs = roots.resolve(rootPath, '');
  const lexicalTarget = roots.resolve(rootPath, relativePath);
  await withFileMutationLocks([rootAbs, lexicalTarget], async () => {
    const target = await roots.resolveMutation(rootPath, relativePath);
    await fs.rm(target, { recursive: true, force: true });
  });
}
