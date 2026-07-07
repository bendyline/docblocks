# @bendyline/docblocks

Core types and abstractions for DocBlocks — the single source of truth for everything that crosses a process or storage boundary (filesystem providers, workspace management, and the Electron host contract).

## Installation

```bash
npm install @bendyline/docblocks
```

## Exports

Three subpath modules (also re-exported from the package root):

### Filesystem (`@bendyline/docblocks/filesystem`)

Pluggable filesystem abstraction — **the single seam for user-document storage**. UI code never touches `indexedDB`, `node:fs`, or `electron` directly; it goes through a provider.

- **`FileSystemProvider`** — the interface (`readFile`, `writeFile`, `readDirectory`, `delete`, `rename`, `createDirectory`, `stat`)
- **`IndexedDBFileSystemProvider`** — browser-local persistent storage (site, VS Code webview fallback)
- **`NativeFileSystemProvider`** — real folders in the browser via the File System Access API
- **`ElectronFileSystemProvider`** — bridges to the desktop main process over the host API
- **`IndexedDBContentContainer`** / **`FileSystemContentContainer`** — content-container layer for media alongside documents
- **`createFileMediaProvider`** — media provider wired to a filesystem provider

```ts
import { IndexedDBFileSystemProvider } from '@bendyline/docblocks/filesystem';

const fs = new IndexedDBFileSystemProvider('my-workspace');
await fs.writeFile('/doc.md', '# Hello');
const content = await fs.readFile('/doc.md');
```

Adding a new storage backend means adding a new provider implementation — the rest of the app shouldn't need to change.

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

The canonical contract for what the Electron desktop shell exposes to its renderer (`fs`, `workspaces`, `shell`, `ffmpeg`, `updater`, `menu`, open-file requests).

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
