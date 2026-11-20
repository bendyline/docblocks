/**
 * The workspace index's worker: analysis, its SQLite store (origin-private,
 * so it survives relaunches) and search. The renderer talks to it through
 * the shell's `workspaceIndexWorker` (see `workspaceIndexConfig.ts`).
 */
import sqliteWasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm?url';
import type { EngineHost } from '@bendyline/docblocks/workspace-index';
import { startWorkspaceIndexWorker } from '@bendyline/docblocks-react/workspace-index-worker';

startWorkspaceIndexWorker(self as unknown as EngineHost, { sqliteWasmUrl });
