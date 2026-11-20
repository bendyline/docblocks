import type { WorkspaceIndexWorkerOption } from '@bendyline/docblocks-react';
import WorkspaceIndexWorker from './workspace-index.worker.ts?worker';

/**
 * The workspace index runs its analysis, storage and search in a worker
 * whose SQLite store lives in the `app://` origin's private storage, so a
 * reopened workspace reads only what changed since last time.
 */
export const DESKTOP_WORKSPACE_INDEX_WORKER: WorkspaceIndexWorkerOption = {
  surface: 'desktop',
  create: () => new WorkspaceIndexWorker({ name: 'docblocks-workspace-index' }),
};
