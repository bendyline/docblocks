# @bendyline/docblocks

Core data structures and filesystem abstractions for DocBlocks.

## Installation

```bash
npm install @bendyline/docblocks
```

## Exports

The package provides two main modules:

### Filesystem (`@bendyline/docblocks/filesystem`)

Pluggable filesystem abstraction layer with multiple storage backends.

- **`FileSystemProvider`** — Abstract interface for filesystem operations (`readFile`, `writeFile`, `readDirectory`, `delete`, `rename`, `createDirectory`, `stat`)
- **`IndexedDBFileSystemProvider`** — Browser-based persistent storage using IndexedDB
- **`NativeFileSystemProvider`** — Native filesystem access via the File System Access API
- **`IndexedDBContentContainer`** — Content management layer for media and document storage

```ts
import { IndexedDBFileSystemProvider } from '@bendyline/docblocks/filesystem';

const fs = new IndexedDBFileSystemProvider('my-workspace');
await fs.writeFile('/doc.md', '# Hello');
const content = await fs.readFile('/doc.md');
```

### Workspace (`@bendyline/docblocks/workspace`)

Workspace management utilities for organizing document projects.

- **`listWorkspaces`** — List all known workspaces
- **`getWorkspace`** / **`saveWorkspace`** / **`removeWorkspace`** — CRUD operations
- **`touchWorkspace`** — Update last-opened timestamp
- **`ensureDefaultWorkspace`** — Create a default workspace if none exist

```ts
import { listWorkspaces, ensureDefaultWorkspace } from '@bendyline/docblocks/workspace';

const workspaces = await listWorkspaces();
```

## License

MIT
