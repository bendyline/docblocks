import type { FileSystemEntry } from '@bendyline/docblocks/filesystem';
import type { DocBlocksHostClipboardAPI, DocBlocksHostShellAPI } from '@bendyline/docblocks/host';
import type { FileTreeNodeAction } from '../FileExplorer/FileTreeNode.js';

export interface NativeFileActionHost {
  /** Absent on hosts with no file-manager concept, such as iOS. */
  shell?: Partial<Pick<DocBlocksHostShellAPI, 'revealInFolder'>>;
  /** Absent where there is no meaningful absolute path, such as Android SAF. */
  clipboard?: Partial<Pick<DocBlocksHostClipboardAPI, 'writeWorkspacePath'>>;
}

/**
 * Build host-provided file actions without leaking absolute paths into the
 * renderer.
 *
 * Each action is gated on the specific bridge member it needs, rather than the
 * whole group being gated on "is this Electron". The two genuinely differ:
 * iOS has no "reveal in file manager", and an Android SAF tree has no absolute
 * path worth copying, so a host can offer either, both, or neither.
 */
export function createNativeFileActions(
  entry: FileSystemEntry,
  workspaceId: string | null,
  host: NativeFileActionHost | null,
): readonly FileTreeNodeAction[] {
  if (entry.kind !== 'file' || workspaceId === null || host === null) return [];

  const actions: FileTreeNodeAction[] = [];
  const revealInFolder = host.shell?.revealInFolder;
  if (revealInFolder) {
    actions.push({
      label: 'Open containing folder',
      onSelect: () => revealInFolder(workspaceId, entry.path),
    });
  }
  const writeWorkspacePath = host.clipboard?.writeWorkspacePath;
  if (writeWorkspacePath) {
    actions.push({
      label: 'Copy full path',
      onSelect: () => writeWorkspacePath(workspaceId, entry.path),
    });
  }
  return actions;
}
