import type { WorkspaceIndexWorkerOption } from '@bendyline/docblocks-react';
import WorkspaceIndexWorker from './workspace-index.worker.ts?worker';

/**
 * The workspace index keeps its analysis in an origin-private SQLite store,
 * so a reopened workspace reads only what changed. iOS may evict that
 * storage (WKWebView will not mark it persistent); the index then rebuilds.
 */
export const MOBILE_WORKSPACE_INDEX_WORKER: WorkspaceIndexWorkerOption = {
  surface: 'mobile',
  create: () => new WorkspaceIndexWorker({ name: 'docblocks-workspace-index' }),
};
