# DocBlocks

**A markdown document editor where one file can become anything — a Word doc, a PDF, a slide deck, an e-book, or a video — and the file stays yours.**

DocBlocks is a local-first document editor and management platform. You write plain markdown; DocBlocks gives you a rich WYSIWYG editing surface (powered by [Squisq](https://github.com/bendyline/squisq)), organizes your documents into workspaces, and turns them into polished output in a dozen shapes. No account, no proprietary format, no lock-in: your documents are `.md` files on disk (or in your browser's local storage), readable by you, your tools, and your AI agents.

## Try it

DocBlocks ships as **four surfaces** from this one repository:

| Surface     | What it is                                                                                                            | How to get it                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Web**     | Full editor in the browser — files persist locally (IndexedDB) or in folders you grant via the File System Access API | `npm run dev` → http://localhost:5220, or the GitHub Pages deployment                                      |
| **Desktop** | Electron app for macOS / Windows / Linux with real folders, native menus, tray, and auto-update                       | Installers on [GitHub Releases](https://github.com/bendyline/docblocks/releases), or `npm run dev:desktop` |
| **VS Code** | A default DocBlocks editor for `*.md` files plus a Setup pane — works in desktop VS Code and VS Code for the Web      | Open `packages/vscode` in VS Code and press F5, or `npm run test:web -w docblocks-vscode`                  |
| **CLI**     | `docblocks` — init, build, serve, convert, video rendering, and an MCP server for AI agents                           | `npm install -g @bendyline/docblocks-cli`                                                                  |

## What it does

- **Three views of every document** — **Editor** (rich WYSIWYG), **Markdown** (raw source), and **Play**, which presents the same file as a **Video**, **Slideshow**, **Document**, or **Page**.
- **Multi-format export** — PDF, Word (DOCX), PowerPoint (PPTX), HTML, and Markdown from the editor; DOCX / PPTX / PDF / HTML / DBK containers and **MP4 video** (with synced animations and captions) from the CLI.
- **Themes and transforms** — visual themes (documentary, cinematic, bold, …) and content transform styles (magazine, data-driven, narrative, …) applied at export or in Play mode.
- **Workspaces** — browser-local, native-folder, or desktop workspaces; documents are always plain markdown files you can open with anything else.
- **Version history** — optional per-document revisions kept in a plain `<name>_files/.versions/` sibling folder. On by default for browser workspaces, off for local folders (your files, your call).
- **AI-agent ready** — `docblocks mcp` starts a [Model Context Protocol](https://modelcontextprotocol.io) server exposing export, analysis, and restyle tools, so assistants like Claude or Copilot can write markdown and ship it as a PDF, deck, or video without leaving the conversation.

## Repository map

npm-workspaces monorepo, Node ≥ 22.14:

| Package                                          | npm name                     | Purpose                                                                                                           |
| ------------------------------------------------ | ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [`packages/core`](packages/core/README.md)       | `@bendyline/docblocks`       | Shared types and seams: filesystem providers, workspace management, host API contract                             |
| [`packages/react`](packages/react/README.md)     | `@bendyline/docblocks-react` | `<DocBlocksShell>` and the UI component library (file explorer, workspace picker, export dialog, …)               |
| [`packages/cli`](packages/cli/README.md)         | `@bendyline/docblocks-cli`   | The `docblocks` binary: init / build / serve / convert / video / mcp / parse / themes / transforms                |
| [`packages/vscode`](packages/vscode/README.md)   | `docblocks-vscode`           | VS Code extension: default DocBlocks markdown editor + Setup pane (dual build for desktop VS Code and vscode.dev) |
| [`packages/desktop`](packages/desktop/README.md) | `docblocks-desktop`          | Electron app (main / preload / renderer), packaged with electron-builder                                          |
| [`packages/site`](packages/site/README.md)       | `docblocks-site`             | The web app — a Vite/React site that mounts `<DocBlocksShell>`                                                    |

The rich-text editor itself is **Squisq**, a sister project that ships as `@bendyline/squisq*` packages. DocBlocks consumes it as a dependency (see `npm run link:squisq` for parallel development).

## Development

```bash
npm install

# The big green button — build + bundle-size check + lint + format check + typecheck + test
npm run all

# Build everything (core → react → cli → vscode → desktop → site)
npm run build

# Package the VS Code extension as a VSIX
npm run package:vscode

# Run a surface
npm run dev            # site on http://localhost:5220
npm run app            # Build shared packages, then launch Electron + Vite on port 5221
npm run dev:desktop    # Launch Electron + Vite without rebuilding shared packages
# VS Code: open packages/vscode in VS Code and press F5
```

### Testing

```bash
npm test                  # Mocha unit tests across all packages
npm run test:e2e          # Playwright drives the site (port 5220)
npm run test:e2e:desktop  # Playwright launches the built Electron app
npm run test:e2e:vscode   # Playwright drives VS Code for the Web (port 3100)
npm run test:a11y         # Accessibility checks against the site
```

### Conventions

- **Conventional Commits** — enforced by commitlint on every commit.
- Releases are per-package via `multi-semantic-release` (`npm run release`, CI-driven); release workflows also package the VS Code extension as a `.vsix` artifact.
- Architecture conventions (the seams between packages, hard lint rules, gotchas) live in [CLAUDE.md](CLAUDE.md) — read it before making cross-package changes.

## License

[MIT](LICENSE) © Bendyline. Third-party font and dependency notices are in [NOTICE.md](NOTICE.md).
