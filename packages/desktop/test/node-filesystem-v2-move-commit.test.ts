import { expect } from 'chai';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  FsError,
  isFileSystemMoveRecoveryError,
  moveFileSystemEntry,
  parseWorkspacePath,
  type FileSystemProvider,
} from '@bendyline/docblocks/filesystem';
import { NodeWorkspaceFileSystemV2 } from '../main/node-workspace-filesystem-v2.js';
import { getWorkspaceRoots, type WorkspaceRoots } from '../main/workspace-roots.js';

let providerSequence = 0;

/**
 * Wrap the real resolver so the post-rename identity assert observes a
 * divergent physical target, exactly as a concurrent external mutation of the
 * destination would. Every other resolution stays authentic.
 */
function rootsWithDivergentRecheck(
  base: WorkspaceRoots,
  targetRelPath: string,
  divergentPath: string,
): WorkspaceRoots {
  let mutationResolutions = 0;
  return {
    ...base,
    async resolveMutation(rootPath: string, relPath: string): Promise<string> {
      const resolved = await base.resolveMutation(rootPath, relPath);
      if (relPath !== targetRelPath) return resolved;
      mutationResolutions += 1;
      // The first resolution addresses the rename itself; the second is the
      // post-rename assertMutationTarget recheck.
      return mutationResolutions >= 2 ? divergentPath : resolved;
    },
  };
}

describe('NodeWorkspaceFileSystemV2 move commit boundary', () => {
  it('reports failure even though the rename already committed', async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'docblocks-move-commit-'));
    const id = `node-v2-move-commit-${++providerSequence}`;
    const base = getWorkspaceRoots();
    base.register(id, rootPath);
    const roots = rootsWithDivergentRecheck(
      base,
      'renamed.md',
      path.join(rootPath, 'somewhere-else.md'),
    );
    const provider = new NodeWorkspaceFileSystemV2(id, 'Move commit', rootPath, roots);
    try {
      await provider.initialize();
      const source = parseWorkspacePath('/note.md');
      const destination = parseWorkspacePath('/renamed.md');
      await provider.writeFile(source, new TextEncoder().encode('payload'));

      let failure: unknown;
      try {
        await provider.move(source, destination);
      } catch (error: unknown) {
        failure = error;
      }

      // The caller is told the move failed...
      expect(failure).to.be.instanceOf(FsError);
      expect((failure as FsError).code).to.equal('conflict');
      expect((failure as FsError).operation).to.equal('move');

      // ...but the rename already committed and was never rolled back.
      expect(await fs.readdir(rootPath)).to.deep.equal(['renamed.md']);
      expect(await fs.readFile(path.join(rootPath, 'renamed.md'), 'utf8')).to.equal('payload');

      // The reported-failed source path no longer exists: the provider's own
      // view now disagrees with what the caller was told.
      expect(await provider.stat(source)).to.equal(null);
      expect(await provider.stat(destination)).to.not.equal(null);
    } finally {
      await provider.dispose();
      base.unregister(id);
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  });

  it('surfaces the committed rename to callers through the move recovery protocol', async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'docblocks-move-commit-'));
    const id = `node-v2-move-recover-${++providerSequence}`;
    const base = getWorkspaceRoots();
    base.register(id, rootPath);
    const roots = rootsWithDivergentRecheck(
      base,
      'renamed.md',
      path.join(rootPath, 'somewhere-else.md'),
    );
    const providerV2 = new NodeWorkspaceFileSystemV2(id, 'Move recover', rootPath, roots);
    // moveFileSystemEntry only ever reaches the v2 seam via `provider.v2`.
    const provider = { v2: providerV2 } as unknown as FileSystemProvider;
    try {
      await providerV2.initialize();
      await providerV2.writeFile(
        parseWorkspacePath('note.md'),
        new TextEncoder().encode('payload'),
      );

      let failure: unknown;
      try {
        await moveFileSystemEntry(provider, 'note.md', 'renamed.md', 'file');
      } catch (error: unknown) {
        failure = error;
      }

      // The raw FsError is NOT what the caller sees. move-entry re-probes the
      // filesystem and reports where the entry actually ended up, so the caller
      // can converge instead of trusting a bare "move failed".
      expect(isFileSystemMoveRecoveryError(failure)).to.equal(true);
      expect(failure).to.not.be.instanceOf(FsError);
      if (!isFileSystemMoveRecoveryError(failure)) throw new Error('unreachable');
      expect(failure.location).to.equal('destination');
      expect(failure.documentLocation).to.equal('destination');
      expect(failure.state.source).to.equal('missing');
      expect(failure.state.destination).to.equal('present');
      expect(failure.moveError).to.be.instanceOf(FsError);
    } finally {
      await providerV2.dispose();
      base.unregister(id);
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  });
});
