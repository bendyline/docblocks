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

## Components

### DocBlocksShell

The canonical DocBlocks experience in one component — file explorer, workspace picker, app menu, the Squisq editor with its Editor / Markdown / Play views, and the export pipeline.

```tsx
<DocBlocksShell theme="auto" logoUrl="/logo.png" />
```

- `theme` — `'light' | 'dark' | 'auto'` (auto follows `prefers-color-scheme`)
- `logoUrl` — brand mark for the app menu button

Storage is abstracted behind `FileSystemProvider` from `@bendyline/docblocks/filesystem`: browser-local (IndexedDB), native folders (File System Access API), or the Electron host.

### FileExplorer / FileTreeNode

File tree browser with inline create (file + folder), rename, delete, and refresh. Long names truncate gracefully.

### WorkspacePicker

Dropdown for switching between workspaces, creating new ones, and opening local folders, plus the per-workspace settings dialog (rename, download, remove, version-history overrides).

### AppMenu

Top-left brand menu with the app-wide **Settings** dialog (theme preference, global version-history default), optional "Download all workspaces," and the **About** dialog.

### ExportToolbarControls / ExportDialog

The export flow: quick re-export of the last configuration plus the full dialog — format (PDF, Word, PowerPoint, HTML, Markdown), visual theme, and page size.

## Hooks

### `useAutoSave(content, save, delay?)`

Debounced auto-save (default 500ms).

### `useFileTree(provider)`

File tree state management over any `FileSystemProvider` — returns the tree, selection, and mutation functions.

## Styles

```ts
import '@bendyline/docblocks-react/styles';
```

One stylesheet (`docblocks.css`) covers all components in both themes. The package also bundles the self-hosted woff2 fonts used by document themes (see `NOTICE.md` at the repo root for licenses).

## Where new UI belongs

Cross-surface UI that lives inside the shell chrome (file tree, workspace picker, app menu, export dialog) belongs here. The VS Code extension is the deliberate exception — its webview mounts Squisq's `EditorShell` directly because VS Code provides the file explorer, workspace, and theme itself.

## License

MIT
