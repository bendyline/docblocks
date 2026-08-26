/** IPC handler for bounded native clipboard writes. */

import { clipboard } from 'electron';
import { HOST_WIRE_LIMITS, isBoundedString } from '@bendyline/docblocks/host';
import { parseWorkspacePath } from '@bendyline/docblocks/filesystem';

import { registerTrustedIpcHandler } from './ipc-authority.js';
import { getWorkspaceRoots } from './workspace-roots.js';

export function registerClipboardIpc(): void {
  registerTrustedIpcHandler('clipboard:writeText', 1, (_event, textValue: unknown): void => {
    if (!isBoundedString(textValue, HOST_WIRE_LIMITS.documentCharacters)) {
      throw new Error('Invalid clipboard text');
    }
    clipboard.writeText(textValue);
  });

  registerTrustedIpcHandler(
    'clipboard:writeWorkspacePath',
    2,
    async (_event, workspaceValue: unknown, pathValue: unknown): Promise<void> => {
      if (!isBoundedString(workspaceValue, HOST_WIRE_LIMITS.identifierCharacters, 1)) {
        throw new Error('Invalid workspace capability');
      }
      if (!isBoundedString(pathValue, HOST_WIRE_LIMITS.pathCharacters)) {
        throw new Error('Invalid workspace-relative clipboard path');
      }

      const roots = getWorkspaceRoots();
      const workspace = roots.get(workspaceValue);
      if (!workspace) throw new Error('Workspace capability is not registered');
      const canonicalPath = parseWorkspacePath(pathValue);
      const absolutePath = await roots.resolvePhysical(workspace.rootPath, canonicalPath);
      clipboard.writeText(absolutePath);
    },
  );
}
