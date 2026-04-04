# DocBlocks for VS Code

VS Code extension providing a rich markdown editor powered by Squisq, plus a setup pane for onboarding.

## Features

### Custom Markdown Editor

Open any `.md` file with the DocBlocks editor: right-click a file and choose **Open With...** > **DocBlocks Editor**.

The editor provides three views:

- **Raw** — Monaco-based markdown editing with syntax highlighting
- **WYSIWYG** — Rich text editing via Tiptap
- **Preview** — Live slideshow preview

The editor syncs with VS Code's built-in undo/redo, dirty state, and save. Theme (light/dark) follows your VS Code color theme.

### Setup Pane

Click the DocBlocks icon in the Activity Bar to open the setup pane. It checks your environment and guides installation:

- **Node.js** — Detects installation, links to nodejs.org if missing
- **npm** — Verifies package manager availability
- **DocBlocks CLI** — Checks for `@bendyline/docblocks-cli` and offers one-click install

This sets up a productive experience for AI-assisted document creation with GitHub Copilot.

## Development

```bash
# From the monorepo root
npm run build:vscode

# Or press F5 in VS Code with this package open to launch Extension Development Host
```

The extension has two build steps:

1. **Webview** — Vite bundles the React editor app into `dist/webview/`
2. **Extension host** — tsup bundles the VS Code extension into `dist/extension.js`

## Testing

### Run VS Code for the Web (manual testing)

Launch a local instance of VS Code for the Web with the extension loaded:

```bash
# Build first, then start the server
npm run build -w docblocks-vscode
npm run test:web -w docblocks-vscode
```

This starts a server at `http://localhost:3100` with the extension pre-loaded and `test-fixtures/` mounted as the workspace. Open your browser to interact with it manually.

### Run E2E tests (automated)

Automated Playwright tests drive VS Code for the Web to verify the extension:

```bash
# Run the full e2e test suite
npm run test:e2e -w docblocks-vscode
```

This will:

1. Build the extension (webview + host)
2. Start `@vscode/test-web` on port 3100
3. Run Playwright tests against the running instance

The tests verify:

- Extension activation and activity bar icon
- Setup pane with environment checks (Node.js, npm, CLI)
- Custom markdown editor opening and loading content
- Command palette registration

### Test fixtures

Test data lives in `test-fixtures/`. Files placed here are mounted as the virtual workspace when running tests.

## License

MIT
