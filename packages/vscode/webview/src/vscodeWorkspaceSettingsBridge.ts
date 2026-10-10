/**
 * Workspace settings round-trips for the VS Code webview. The host owns the
 * `.docblocks/workspace.json` of the folder containing this panel's document
 * and derives that folder from its own URI; requests here carry only a patch.
 */

import {
  parseExtensionToWebviewMessage,
  type WebviewToExtensionMessage,
} from '@bendyline/docblocks/vscode';
import type { WorkspaceSettingsPatch } from '@bendyline/docblocks/workspace-settings';
import { WebviewRequestRegistry } from './webviewRequestRegistry.js';

type WorkspaceSettingsResponse = { type: 'workspaceSettingsResult'; ok: true };

export interface VscodeWorkspaceSettingsBridge {
  save(patch: WorkspaceSettingsPatch): Promise<void>;
  refreshOutputs(): Promise<void>;
  dispose(): void;
}

export function createVscodeWorkspaceSettingsBridge(
  postMessage: (message: WebviewToExtensionMessage) => void,
): VscodeWorkspaceSettingsBridge {
  const requests = new WebviewRequestRegistry<WorkspaceSettingsResponse>({
    label: 'VS Code workspace settings',
    maxPending: 4,
    timeoutMs: 120_000,
  });

  function handleMessage(event: MessageEvent<unknown>): void {
    const message = parseExtensionToWebviewMessage(event.data);
    if (message?.type !== 'workspaceSettingsResult') return;
    if (message.ok) {
      requests.settle(message.requestId, { type: 'workspaceSettingsResult', ok: true });
    } else {
      requests.reject(
        message.requestId,
        new Error(message.message ?? 'DocBlocks could not update the workspace settings.'),
      );
    }
  }
  window.addEventListener('message', handleMessage);

  return {
    async save(patch) {
      await requests.request('workspaceSettingsResult', (requestId) => {
        postMessage({ type: 'updateWorkspaceSettings', requestId, patch });
      });
    },
    async refreshOutputs() {
      await requests.request('workspaceSettingsResult', (requestId) => {
        postMessage({ type: 'refreshWorkspaceOutputs', requestId });
      });
    },
    dispose() {
      window.removeEventListener('message', handleMessage);
      requests.dispose();
    },
  };
}
