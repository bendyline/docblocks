import type { FileSystemEntry } from '@bendyline/docblocks/filesystem';
import type { DocBlocksHostClipboardAPI, DocBlocksHostShellAPI } from '@bendyline/docblocks/host';
import type { FileTreeNodeAction } from '../FileExplorer/FileTreeNode.js';

export interface NativeFileActionHost {
  shell: Pick<DocBlocksHostShellAPI, 'revealInFolder'>;
  clipboard: Pick<DocBlocksHostClipboardAPI, 'writeWorkspacePath'>;
}

/** Build desktop-only file actions without leaking absolute paths into the renderer. */
export function createNativeFileActions(
  entry: FileSystemEntry,
  workspaceId: string | null,
  host: NativeFileActionHost | null,
): readonly FileTreeNodeAction[] {
  if (entry.kind !== 'file' || workspaceId === null || host === null) return [];

  return [
    {
      label: 'Open containing folder',
      onSelect: () => host.shell.revealInFolder(workspaceId, entry.path),
    },
    {
      label: 'Copy full path',
      onSelect: () => host.clipboard.writeWorkspacePath(workspaceId, entry.path),
    },
  ];
}
