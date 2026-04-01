# @bendyline/docblocks-react

React components for DocBlocks — file explorer, workspace picker, editor shell, and export controls.

## Installation

```bash
npm install @bendyline/docblocks-react
```

**Peer dependencies:** React 18 or 19, plus `@bendyline/docblocks` (core) and `@bendyline/squisq-editor-react`.

## Usage

```tsx
import { DocBlocksShell } from '@bendyline/docblocks-react';
import '@bendyline/docblocks-react/styles';

function App() {
  return <DocBlocksShell theme="light" />;
}
```

## Components

### DocBlocksShell

The main application shell — combines the file explorer, workspace picker, and squisq editor into a complete document editing experience.

```tsx
<DocBlocksShell theme="light" logoUrl="/logo.png" />
```

### FileExplorer

File tree browser with create, rename, delete, and drag-and-drop support.

### WorkspacePicker

Dropdown for switching between workspaces (IndexedDB or native filesystem handles).

### AppMenu

Top menu bar with branding and about dialog.

### ExportToolbarControls / ExportDialog

Export functionality supporting DOCX, PDF, PPTX, HTML, and Markdown output formats with theme and transform options.

## Hooks

### `useAutoSave(content, save, delay?)`

Debounced auto-save hook (default 500ms delay).

### `useFileTree(provider)`

File tree state management — returns the tree structure, selected file, and mutation functions.

## Styles

Import the stylesheet to get the default DocBlocks styling:

```ts
import '@bendyline/docblocks-react/styles';
```

## License

MIT
