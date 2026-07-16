# @bendyline/docblocks-react

React components for DocBlocks — the complete editor shell (file explorer, workspace picker, app menu, export pipeline) plus the individual components and hooks it's built from. This is the package the DocBlocks web app and desktop renderer both mount.

## Installation

```bash
npm install @bendyline/docblocks-react
```

**Peer dependencies:** React 18 or 19. The DocBlocks core (`@bendyline/docblocks`) and the Squisq editor packages are regular dependencies and install automatically.

## Usage

```tsx
import { DocBlocksShell } from '@bendyline/docblocks-react';
import '@bendyline/docblocks-react/styles';

function App() {
  return <DocBlocksShell theme="auto" />;
}
```

The video-export worker uses module chunks. Vite consumers must retain the
same worker setting used by the DocBlocks site and desktop renderer:

```ts
// vite.config.ts
import { defineConfig } from 'vite';

export default defineConfig({ worker: { format: 'es' } });
```

## Components

### DocBlocksShell

The canonical DocBlocks experience in one component — file explorer, workspace picker, app menu, the Squisq editor with its Editor / Markdown / Play views, and the export pipeline.

```tsx
<DocBlocksShell theme="auto" logoUrl="/logo.png" />
```

- `theme` — `'light' | 'dark' | 'auto'` (auto follows `prefers-color-scheme`)
- `logoUrl` — brand mark for the app menu button

Storage is abstracted behind the byte-authoritative `FileSystemProviderV2` contract from `@bendyline/docblocks/filesystem`: browser-local (IndexedDB), native folders (File System Access API), transient memory workspaces, or the Electron host. Built-in compatibility facades expose it as `provider.v2`; first-party shell and file-tree operations are v2-first.

### FileExplorer / FileTreeNode

File tree browser with inline create (file + folder), rename, and delete. It follows filesystem
watch events automatically and re-reads the visible tree when a browser surface resumes. Long
names truncate gracefully.

### WorkspacePicker

Dropdown for switching between workspaces, creating new ones, and opening local folders, plus the per-workspace settings dialog (rename, download, remove, version-history overrides).

### AppMenu

Top-left brand menu with the app-wide **Settings** dialog (theme preference, global version-history default), optional "Download all workspaces," and the **About** dialog.

### ExportToolbarControls / ExportDialog

Consumers that need the export pipeline without the complete shell can use the
public, independently built entry point:

```ts
import {
  DEFAULT_OPTIONS,
  ExportDialog,
  buildExportFilename,
  runExport,
} from '@bendyline/docblocks-react/export';
```

The shell overflow also offers **Share link with content embedded**. It creates
a bounded `#shared(<base64>)` URL containing a compressed, Markdown-only copy
and an optional initial Use mode. Opening the URL creates a session-only
workspace; generated links warn after 4,096 characters and are capped at
32,768 characters.

The export flow: quick re-export of the last configuration plus the full dialog — format (PDF, Word, PowerPoint, HTML, Markdown), visual theme, and page size.

## Hooks

### `useDocumentSession(delay?)`

React binding for the revisioned `DocumentSession`. Active-document writes,
transitions, conflicts, and close preparation must flow through this session;
there is intentionally no independent autosave hook.

### `useFileTree(provider)`

File tree state management over any v2-capable provider — returns the tree, selection, and explicit create/move/remove functions, with a temporary v1 fallback for external providers.

## Styles

```ts
import '@bendyline/docblocks-react/styles';
```

One stylesheet (`docblocks.css`) covers all components in both themes. The package also bundles the self-hosted woff2 fonts used by document themes (see `NOTICE.md` at the repo root for licenses).

## Where new UI belongs

Cross-surface UI that lives inside the shell chrome (file tree, workspace picker, app menu, export dialog) belongs here. The VS Code extension is the deliberate exception — its webview mounts Squisq's `EditorShell` directly because VS Code provides the file explorer, workspace, and theme itself.

## License

MIT
