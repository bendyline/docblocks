# @bendyline/docblocks

Core types and abstractions for DocBlocks — the single source of truth for everything that crosses a process or storage boundary (filesystem providers, workspace management, and the Electron host contract).

## Installation

```bash
npm install @bendyline/docblocks
```

## Exports

Four subpath modules (also re-exported from the package root):

### Filesystem (`@bendyline/docblocks/filesystem`)

Correctness-first, byte-authoritative filesystem abstraction — **the single seam for user-document storage**. UI code never touches `indexedDB`, `node:fs`, or `electron` directly; it goes through a provider.

- **`FileSystemProviderV2`** — canonical branded paths, typed errors, explicit mutation modes, opaque versions, capabilities, snapshots, watches, and disposal
- **`WorkspacePath` / `parseWorkspacePath()`** — the portable logical path representation (`''` is workspace root)
- **`FsError`** — stable error codes that survive IPC/structured clone boundaries
- **`IndexedDBFileSystemProvider`** — browser-local persistent storage (site, VS Code webview fallback)
- **`NativeFileSystemProvider`** — real folders in the browser via the File System Access API
- **`ElectronFileSystemProvider`** — bridges to the desktop main process over the host API
- **`MemoryFileSystemProvider`** — authoritative in-memory v2 storage for transient loose-file and DBK workspaces
- **`IndexedDBContentContainer`** / **`FileSystemContentContainer`** — content-container layer for media alongside documents
- **`createFileMediaProvider`** — media provider wired to a filesystem provider

```ts
import { IndexedDBFileSystemProvider, parseWorkspacePath } from '@bendyline/docblocks/filesystem';

const fs = new IndexedDBFileSystemProvider('my-workspace', 'My workspace');
const path = parseWorkspacePath('/doc.md');
await fs.v2.writeFile(path, new TextEncoder().encode('# Hello'), {
  mode: 'create',
  createParents: true,
});
const content = await fs.v2.readFile(path);
```

`FileSystemProvider` remains as a deprecated text compatibility facade during the v2 migration. New code should discover `provider.v2` with `getFileSystemProviderV2()` and use v1 only as an explicit compatibility fallback. Every new backend must pass the shared v2 conformance suite.

Provider families also have isolated entry points so a browser or desktop
surface can load only the backend it selects:

- `@bendyline/docblocks/filesystem/indexeddb`
- `@bendyline/docblocks/filesystem/memory`
- `@bendyline/docblocks/filesystem/native`
- `@bendyline/docblocks/filesystem/electron`

Use literal dynamic imports of those subpaths in multi-surface shells. The
compatibility `filesystem` barrel still re-exports every provider, but eagerly
constructing from that barrel puts mutually exclusive backends in one startup
bundle.

Mutation behavior is explicit: `writeFile` requires a `create`, `replace`, or
`upsert` mode; `remove` distinguishes an empty-directory removal from a
recursive tree removal; and `move` never overwrites its destination. Missing
entries are returned as `null` only by `stat` and `readFile`. Permission,
wrong-kind, conflict, quota, and I/O failures remain typed `FsError`s.

Capability declarations are conservative promises, not marketing labels:

| Provider                  | Write         | Move          | Snapshot      | Conditional write | Watch | Durability  |
| ------------------------- | ------------- | ------------- | ------------- | ----------------- | ----- | ----------- |
| Memory                    | process       | process       | process       | process           | yes   | volatile    |
| IndexedDB                 | cross-context | cross-context | cross-context | storage-atomic    | no    | best-effort |
| Native File System Access | none          | none          | none          | process           | no    | best-effort |
| Electron workspace        | process       | process       | process       | process           | yes   | best-effort |

Versions are opaque equality tokens scoped to their issuing provider. A
consumer must never parse them or compare tokens from different providers.
When a watch reports `overflow`, discard incremental assumptions and reload or
snapshot the relevant state.

IndexedDB workspaces migrate the legacy `fs:*` text/binary namespace in one
transaction and then use v2 records as their sole authority. Divergent legacy
or pre-release v2 data is retained as an explicit recovery candidate instead
of being guessed away. If an obsolete tab recreates legacy keys, a bounded
prefix probe quarantines that branch before the requested operation retries;
ordinary operations do not scan or deserialize the complete workspace.

### Document (`@bendyline/docblocks/document`)

Framework-neutral document transaction/session primitives: serialized latest-write commits, monotonic revisions, explicit transitions/retarget/delete/close, conflict state, and crash-recovery journals.

### Workspace (`@bendyline/docblocks/workspace`)

Workspace registry — how DocBlocks tracks the document collections a user has opened.

- **`WorkspaceDescriptor`** — the workspace record type
- **`listWorkspaces`** / **`getWorkspace`** / **`saveWorkspace`** / **`removeWorkspace`** — registry CRUD
- **`touchWorkspace`** — update the last-opened timestamp
- **`ensureDefaultWorkspace`** — create a default workspace if none exist

```ts
import { listWorkspaces, ensureDefaultWorkspace } from '@bendyline/docblocks/workspace';

const workspaces = await listWorkspaces();
```

### Host (`@bendyline/docblocks/host`)

The canonical contract for what the Electron desktop shell exposes to its renderer (`fsV2`, legacy `fs`, `workspaces`, `shell`, `ffmpeg`, `updater`, `menu`, open-file requests).

- **`DocBlocksHostAPI`** — the contract type (implemented by `desktop/main/ipc-*.ts`, exposed by `desktop/preload/preload.ts`)
- **`isElectronHost()`** — feature-detect the desktop shell
- **`getDocBlocksHost()`** — get the host API (throws outside Electron)
- **`maybeGetDocBlocksHost()`** — get the host API or `null`, for code that degrades gracefully in the browser

```ts
import { isElectronHost, maybeGetDocBlocksHost } from '@bendyline/docblocks/host';

const host = maybeGetDocBlocksHost();
if (host) {
  await host.shell.revealInFolder(path);
}
```

## Conventions

Anything that crosses IPC, postMessage, HTTP, or MCP boundaries belongs in this package — surface packages must not define their own copies of wire types.

## License

MIT
