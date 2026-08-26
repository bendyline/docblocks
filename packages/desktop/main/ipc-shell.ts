/** IPC handlers for bounded shell operations over existing capabilities. */

import { shell } from 'electron';
import { HOST_WIRE_LIMITS, isBoundedString, parseExternalHttpUrl } from '@bendyline/docblocks/host';
import { parseWorkspacePath } from '@bendyline/docblocks/filesystem';

import { registerTrustedIpcHandler } from './ipc-authority.js';
import { getWorkspaceRoots } from './workspace-roots.js';

export function registerShellIpc(): void {
  registerTrustedIpcHandler(
    'shell:revealInFolder',
    2,
    async (_event, workspaceValue: unknown, pathValue: unknown): Promise<void> => {
      if (!isBoundedString(workspaceValue, HOST_WIRE_LIMITS.identifierCharacters, 1)) {
        throw new Error('Invalid workspace capability');
      }
      const workspacePath = pathValue === undefined ? '' : pathValue;
      if (!isBoundedString(workspacePath, HOST_WIRE_LIMITS.pathCharacters)) {
        throw new Error('Invalid workspace-relative reveal path');
      }
      const roots = getWorkspaceRoots();
      const workspace = roots.get(workspaceValue);
      if (!workspace) throw new Error('Workspace capability is not registered');
      const canonicalPath = parseWorkspacePath(workspacePath);
      const absolutePath = await roots.resolvePhysical(workspace.rootPath, canonicalPath);
      shell.showItemInFolder(absolutePath);
    },
  );

  registerTrustedIpcHandler(
    'shell:openWorkspaceFolder',
    1,
    async (_event, workspaceValue: unknown): Promise<void> => {
      if (!isBoundedString(workspaceValue, HOST_WIRE_LIMITS.identifierCharacters, 1)) {
        throw new Error('Invalid workspace capability');
      }
      const roots = getWorkspaceRoots();
      const workspace = roots.get(workspaceValue);
      if (!workspace) throw new Error('Workspace capability is not registered');
      const absolutePath = await roots.resolvePhysical(workspace.rootPath, '');
      const errorMessage = await shell.openPath(absolutePath);
      if (errorMessage) throw new Error(errorMessage);
    },
  );

  registerTrustedIpcHandler(
    'shell:openExternal',
    1,
    async (_event, urlValue: unknown): Promise<void> => {
      const url = parseExternalHttpUrl(urlValue);
      if (!url) throw new Error('Only credential-free HTTP(S) URLs may be opened externally');
      await shell.openExternal(url);
    },
  );
}
