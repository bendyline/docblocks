# DocBlocks for VS Code

VS Code extension that turns `*.md` files into rich DocBlocks documents — a default markdown editor powered by Squisq, plus a Setup tab for getting the full DocBlocks toolchain running.

## Features

### Markdown editor

Open any `.md` file and VS Code routes it into the DocBlocks editor by default. You can also right-click a markdown file and choose **Open in DocBlocks**, or run **DocBlocks: Open Editor** from the command palette.

The editor gives you the same three views as every other DocBlocks surface:

- **Editor** — rich WYSIWYG editing (Squisq)
- **Markdown** — the raw markdown source
- **Play** — presents the document as a Video, Slideshow, Document, or Page

The editor autosaves markdown changes back to the backing file and resolves media through the sibling `<name>_files/` folder. VS Code keeps its own file explorer, tabs, and theme — the DocBlocks webview is intentionally chrome-less.

### Setup tab

Run **DocBlocks: Open Setup** from the command palette to open the Setup tab. It checks your environment and guides installation of the optional toolchain:

- **Node.js** — detects installation, links to nodejs.org if missing
- **npm** — verifies package manager availability
- **DocBlocks CLI** — checks for `@bendyline/docblocks-cli` and offers a one-click install

The editor works without any of these; the CLI unlocks conversion, video rendering, and the MCP server for AI-assisted document workflows.

### Commands

| Command                  | What it does                                          |
| ------------------------ | ----------------------------------------------------- |
| `DocBlocks: Open Editor` | Open the active markdown file in the DocBlocks editor |
| `Open in DocBlocks`      | Context-menu entry on markdown files                  |
| `DocBlocks: Open Setup`  | Open the Setup tab                                    |

## Dual build (desktop VS Code + vscode.dev)

The extension host ships two bundles from one source:

- `dist/extension.js` — the Node-backed host (desktop VS Code); can spawn processes for environment checks
- `dist/extension.web.js` — the web host (vscode.dev / VS Code for the Web); no Node APIs allowed

Don't let Node-only imports (`fs`, `child_process`, Node-semantics `path`) sneak into code shared with the web bundle. The webview itself (`webview/`) is a Vite-built React app bundled into `dist/webview/`; it never imports `vscode` — the host ↔ webview boundary is the discriminated-union message types in `src/messages.ts`.

## Development

```bash
# From the monorepo root
npm run build:vscode

# Or press F5 in VS Code with this package open to launch the Extension Development Host
```

`npm run build` here runs tsup (extension host bundles) then Vite (webview).

### Package VSIX

```bash
npm run package:vscode
```

This builds the extension and writes `packages/vscode/docblocks-vscode-<version>.vsix`.

## Testing

### Run VS Code for the Web (manual testing)

```bash
npm run build -w docblocks-vscode
npm run test:web -w docblocks-vscode
```

This starts VS Code for the Web at `http://localhost:3100` with the extension pre-loaded. Point it at `test-fixtures/` for sample content.

### Run e2e tests (automated)

```bash
npm run test:e2e -w docblocks-vscode
```

This builds the extension, starts `@vscode/test-web` on port 3100 with `test-fixtures/` mounted as the workspace, and runs the Playwright suites:

- Extension activation and command registration
- Setup tab environment checks and re-check button
- Default markdown editor opening and rendering fixture content
- Command palette registration

Test data lives in `test-fixtures/`.

## License

MIT
