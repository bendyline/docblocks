/**
 * Owns the active workspace's catalog-output scheduler. A new scheduler is
 * created per workspace and disposed (cancelling any in-flight walk) when the
 * workspace changes, so a commit captured for one workspace can never refresh
 * another.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { getFileSystemProviderV2, type FileSystemProvider } from '@bendyline/docblocks/filesystem';
import {
  createWorkspaceOutputsScheduler,
  IDLE_WORKSPACE_OUTPUTS_STATUS,
  type WorkspaceOutputsScheduler,
  type WorkspaceOutputsStatus,
  type WorkspaceSettings,
} from '@bendyline/docblocks/workspace-settings';
import { loadDefaultWorkspaceOutputsRenderer } from './workspace-outputs.js';

const noSubscription = () => () => undefined;
const idleStatus = () => IDLE_WORKSPACE_OUTPUTS_STATUS;

export interface UseWorkspaceOutputsResult {
  readonly scheduler: WorkspaceOutputsScheduler | null;
  readonly status: WorkspaceOutputsStatus;
}

export function useWorkspaceOutputs(
  provider: FileSystemProvider | null,
  workspaceId: string | null,
  settings: WorkspaceSettings | null,
  enabled: boolean,
): UseWorkspaceOutputsResult {
  const providerV2 = provider && enabled ? getFileSystemProviderV2(provider) : null;
  const [scheduler, setScheduler] = useState<WorkspaceOutputsScheduler | null>(null);

  useEffect(() => {
    if (!providerV2 || !workspaceId) {
      setScheduler(null);
      return;
    }
    const next = createWorkspaceOutputsScheduler({
      workspaceId,
      provider: providerV2,
      settings: null,
      renderer: loadDefaultWorkspaceOutputsRenderer,
    });
    setScheduler(next);
    const flushWhenHidden = () => {
      if (document.visibilityState === 'hidden') next.flush();
    };
    document.addEventListener('visibilitychange', flushWhenHidden);
    return () => {
      document.removeEventListener('visibilitychange', flushWhenHidden);
      next.dispose();
    };
  }, [providerV2, workspaceId]);

  useEffect(() => {
    scheduler?.updateSettings(settings);
  }, [scheduler, settings]);

  const status = useSyncExternalStore(
    scheduler ? scheduler.subscribe : noSubscription,
    scheduler ? scheduler.getStatus : idleStatus,
  );
  return { scheduler, status };
}
