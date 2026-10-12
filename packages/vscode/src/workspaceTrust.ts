import * as vscode from 'vscode';

/**
 * True when the open workspace is trusted. DocBlocks only runs setup commands
 * and writes generated files (workspace catalogs, settings) in trusted
 * workspaces: a cloned repository's `.docblocks/workspace.json` must not make
 * VS Code write files merely because it was opened in Restricted Mode.
 */
export function isWorkspaceTrusted(): boolean {
  return vscode.workspace.isTrusted;
}

/** Like {@link isWorkspaceTrusted}, telling the user why an action did not run. */
export async function requireTrustedWorkspace(reason: string): Promise<boolean> {
  if (isWorkspaceTrusted()) return true;
  await vscode.window.showWarningMessage(`Trust this workspace before DocBlocks ${reason}.`);
  return false;
}
