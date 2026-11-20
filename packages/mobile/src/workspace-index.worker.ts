/**
 * The workspace index's worker: analysis, its SQLite store (origin-private,
 * so it survives relaunches when the system keeps it) and search. The app
 * talks to it through the shell's `workspaceIndexWorker`.
 */
import sqliteWasmUrl from '@sqlite.org/sqlite-wasm/sqlite3.wasm?url';
import type { EngineHost } from '@bendyline/docblocks/workspace-index';
import { startWorkspaceIndexWorker } from '@bendyline/docblocks-react/workspace-index-worker';

startWorkspaceIndexWorker(self as unknown as EngineHost, { sqliteWasmUrl });
