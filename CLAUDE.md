# CLAUDE.md

Guidance for Claude Code (and any other AI coding agent) working in this repo. Read this first; the conventions below are load-bearing.

> **Canonical guidance:** [`AGENTS.md`](AGENTS.md) supersedes this legacy summary.
> Use [`docs/cli.md`](docs/cli.md) for the current CLI contract and
> [`docs/mcp.md`](docs/mcp.md) for the current MCP architecture and protocol.

## What DocBlocks is

A markdown document editor and management platform that ships from one npm-workspaces monorepo to **four delivery surfaces**:

- **Site** (`packages/site`) — a Vite/React demo of the shell, deployed to GitHub Pages
- **Desktop** (`packages/desktop`) — an Electron app for macOS / Windows / Linux
- **VS Code extension** (`packages/vscode`) — a custom editor for `*.md` files plus a Setup pane
- **CLI** (`packages/cli`) — `docblocks` binary for build / serve / convert / video / mcp / parse / themes / transforms

The **site** and **desktop renderer** both mount `<DocBlocksShell>` from `@bendyline/docblocks-react` — the full chrome (file explorer, workspace picker, app menu, export pipeline). The **VS Code webview** is chrome-less: it mounts squisq's `EditorShell` directly because VS Code already provides its own file explorer, workspace, and activity bar. The actual rich-text editor in every surface is **Squisq**, a sister project that lives in `..\squisq` and ships as `@bendyline/squisq*` npm packages.

## Packages

| Package            | npm name                     | Purpose                                                                                                                                                                                                                                                                                                             |
| ------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`    | `@bendyline/docblocks`       | Shared types. Multi-entry tsup build with subpaths: `/filesystem`, `/workspace`, `/host`. **Single source of truth for wire types.**                                                                                                                                                                                |
| `packages/react`   | `@bendyline/docblocks-react` | `<DocBlocksShell>`, `FileExplorer`, `WorkspacePicker`, `AppMenu`, `Export*`, hooks, `styles/docblocks.css`. Consumed by site + desktop renderer. (Ships no fonts — theme fonts live in `packages/site/public/fonts/`.) (VS Code webview uses squisq's `EditorShell` directly — see the editor-shell section below.) |
| `packages/cli`     | `@bendyline/docblocks-cli`   | Commander program with 8 commands. Owns CLI/MCP policy and delegates parsing, conversion, rendering, and authoring capabilities to linked Squisq.                                                                                                                                                                   |
| `packages/vscode`  | `docblocks-vscode`           | Extension host (Node) + Vite-built React webview. Dual build: `extension.js` + `extension.web.js` for vscode.dev.                                                                                                                                                                                                   |
| `packages/desktop` | `docblocks-desktop`          | Electron — `main/` + `preload/preload.ts` + `renderer/` (Vite + React, mounts `<DocBlocksShell>`). Packaged with electron-builder.                                                                                                                                                                                  |
| `packages/site`    | `docblocks-site`             | Single-component Vite app showing `<DocBlocksShell theme="auto">`.                                                                                                                                                                                                                                                  |

## Build, test, dev commands

Node 22.22.2+, 24.15.0+, or 26+ required. PowerShell users — these all work as plain `npm` commands; no shell-specific syntax.

```bash
# The big green button — build, bundle-size, site precache + fonts, desktop config,
# agent guidance, the assurance contract, lint, format:check, typecheck, package
# consumers, critical coverage, unit/integration tests, and every E2E suite
npm run all

# Build
npm run build               # all packages in order: core → react → cli → vscode → desktop
npm run build:core          # one package (also :react, :cli, :vscode, :desktop)

# Dev
npm run dev                 # alias for npm run site — site on http://localhost:5220
npm run site                # explicit form
npm run dev:desktop         # Electron + Vite concurrently on 5221
# VS Code extension: open packages/vscode in VS Code and hit F5

# Test
npm test                    # Mocha across all packages/*/test/**/*.test.ts (tsx loader)
# No package defines its own `test` script — `npm test -w <pkg>` fails with
# "Missing script". The root .mocharc.yml globs every package, and a positional
# path is ADDED to that glob rather than replacing it. To run one file:
npx mocha --no-config --require tsx --require ./packages/react/test/setup.ts <file>
npm run test:e2e            # Playwright drives the site (root config, port 5220)
npm run test:e2e:desktop    # Playwright + Electron launcher
npm run test:e2e:vscode     # Playwright + VS Code for Web (port 3100)

# Quality gates
npm run typecheck           # six independent `tsc --noEmit` runs (no project references)
npm run lint                # eslint flat config
npm run format:check        # prettier
npm run format              # prettier --write

# Squisq parallel dev — symlinks @bendyline/squisq* from ..\squisq
npm run link:squisq         # link
npm run dev:squisq          # link + watch
npm run unlink:squisq       # restore registry versions

# Release — multi-semantic-release per package
npm run release
```

Commits must follow Conventional Commits — commitlint enforces this in CI (pull requests and pushes to `main`); there is no local hook.

## Architecture: the seams that matter

### `FileSystemProvider` is the single seam for user-document storage

`packages/core/src/filesystem/types.ts` defines the interface. Three implementations:

- `IndexedDBFileSystemProvider` — browser-local (site, vscode webview fallback)
- `NativeFileSystemProvider` — File System Access API (browser, opt-in)
- `ElectronFileSystemProvider` — IPC bridge to `desktop/main/ipc-fs.ts`

UI code (in `packages/react`, `packages/site`, `packages/desktop/renderer`, `packages/vscode/webview`) **must not** call `indexedDB`, `node:fs`, or `electron` directly. Go through the provider. Adding a new storage backend means a new provider implementation — the rest of the app shouldn't need to change.

### `DocBlocksHostAPI` is the single seam for Electron capabilities

`packages/core/src/host/types.ts` is the canonical contract for what the desktop shell exposes to the renderer (`fs`, `workspaces`, `shell`, `ffmpeg`, `updater`, `menu`, `open-file`). The contract spans three files that must stay in sync:

```
packages/core/src/host/types.ts          ← contract
packages/desktop/main/ipc-*.ts           ← main-side handlers
packages/desktop/preload/preload.ts      ← contextBridge exposure
```

Renderer code calls `getDocBlocksHost()` / `isElectronHost()` from `@bendyline/docblocks/host` and degrades gracefully when running in a non-Electron context (site, vscode webview). **Renderer must never import `electron` or `node:*`.**

### `<DocBlocksShell>` is the canonical editor shell — for site + desktop

Site and the desktop renderer both mount `<DocBlocksShell>`. The VS Code webview ([packages/vscode/webview/src/VscodeEditor.tsx](packages/vscode/webview/src/VscodeEditor.tsx)) is the documented exception: it mounts squisq's `EditorShell` directly because VS Code provides the file explorer, workspace, and theme via its own activity bar / API. New cross-surface UI that lives **inside the shell chrome** (file tree, workspace picker, app menu, export dialog) belongs in `packages/react/src/`. New editor-area features that need to work in vscode too either go in squisq, or get wired into both `DocBlocksShell` and `VscodeEditor` explicitly.

### Squisq is a dependency, not a fork

Editor-internal behavior (caret, selection, formatting, toolbar, plugins) lives in `..\squisq` and ships as `@bendyline/squisq*`. Patch upstream — never reach into `node_modules/@bendyline/squisq*` from this repo. Use `npm run link:squisq` for parallel development.

## Hard rules (enforced by ESLint or convention)

- **No `any`.** `@typescript-eslint/no-explicit-any: error` outside test files. Use proper types, generics, or `unknown` + a type guard.
- **No `console.log`.** `no-console: error` outside test files and CJS scripts. Surface errors through proper channels (VS Code `OutputChannel`, host API, CLI stderr).
- **No renderer-side Electron / Node imports.** Renderer = `packages/desktop/renderer/` + `packages/site/src/` + `packages/vscode/webview/`. These run in a browser context; importing `electron` or `node:fs` breaks the build for some surfaces and the security model for others.
- **No `vscode` import in the webview.** The VS Code webview is a sandboxed browser context. The host ↔ webview boundary is `packages/core/src/vscode/messages.ts` (runtime-validated discriminated unions) over `postMessage`.
- **Wire types live in `packages/core`.** Anything that crosses IPC, postMessage, HTTP, or MCP boundaries belongs in `core` — usually under `host/types.ts` or `filesystem/types.ts`. Surface packages should not define their own copy.
- **Conventional Commits.** commitlint runs in CI on pull requests **and on pushes to `main`** — the latter matters because multi-semantic-release derives every published version bump from those exact messages. There is **no local git hook**, so a malformed message is caught in CI, not at commit time.
- **Git management is the user's job — never do it for them.** Do not create pull requests, create new branches, or create git worktrees. The user owns all branch, PR, and worktree management. Commit only when explicitly asked; otherwise leave the working tree and git state alone.

## Gotchas worth knowing

- **The `app://` custom protocol** in the Electron renderer is load-bearing. It gives IndexedDB a stable origin (so workspaces persist across launches) and lets Monaco web workers load. Don't switch to `file://`.
- **VS Code dual build.** `extension.js` runs in the Node-backed host; `extension.web.js` runs in vscode.dev. Don't let Node-only imports (`fs`, `path` with Node semantics, `child_process`) sneak into the web bundle.
- **Workspace-roots whitelist.** `packages/desktop/main/workspace-roots.ts` enforces that the renderer can only read/write inside folders the user has explicitly granted. New `ipc-fs` operations must respect it.
- **No `CLAUDE.md` per package.** Conventions live here at the root. Per-package READMEs cover package-specific scripts.
- **Mocha, not Vitest.** The test runner is Mocha (`packages/*/test/**/*.test.ts`) with `tsx` as the loader and Chai for assertions. Don't introduce a second runner.
- **Playwright runs from four configs.** Root (`playwright.config.ts`) drives the site dev server. Root `playwright.offline.config.ts` runs the PWA/offline spec against `vite preview` of a production build (`npm run test:e2e:offline`) — the SW never registers on the dev server, which is why the default config testIgnores `offline.spec.ts`. `packages/desktop/e2e/playwright.config.ts` launches Electron. `packages/vscode/e2e/playwright.config.ts` uses VS Code for Web on port 3100. Each writes to its own `test-results/`.
- **`packages/react` unit tests use happy-dom + a custom `renderHook` helper.** See `packages/react/test/helpers/renderHook.ts` — it's a ~50-line wrapper around React's `act` and `createRoot`, deliberately chosen over `@testing-library/react` to keep deps small. Mocha registers happy-dom globally via `packages/react/test/setup.ts` (loaded by root `.mocharc.yml`). Active-document persistence is tested through `DocumentSession`; do not reintroduce an independent autosave hook.
- **The site is an installable PWA with the entire dist precached (~22 MB).** `vite-plugin-pwa` config lives in `packages/site/vite.config.ts`; SW registration + update prompts in `packages/site/src/pwa.ts` → shell props. Two traps: the service worker exists **only in build/preview** (`devOptions` off), and **any chunk over the 10 MiB `maximumFileSizeToCacheInBytes` cap silently falls out of the precache** — after adding a heavy dependency, confirm it appears in `dist/sw.js` (the offline e2e asserts ts.worker and the fonts as canaries).
- **Theme fonts are served from `packages/site/public/fonts/`** (copied from squisq's site; squisq `fontStacks` expect the host page to supply the `@font-face`s — regenerate upstream via squisq's `download-fonts.ps1`). Electron's renderer does not load them yet (known parity gap).

## Claude skills

Four skills live in `.claude/skills/` — invoke with `/<name>`:

- **`/developmentarchitect`** — full or focused architecture review (duplication, type safety, build system, error handling, etc.). Writes `reports/architecture-review-*.md`.
- **`/qualitymanager`** — test-coverage and quality audit across Mocha + the three Playwright configs. Writes `reports/quality-review-*.md`.
- **`/a11yreview`** — WCAG 2.1 AA audit across site / desktop renderer / vscode webview / Setup pane. Writes `reports/a11y-review-*.md` and fixes common issues directly.
- **`/uxreview`** — visual / UX critique with explicit multi-surface parity assessment. Writes `reports/ux-review-report-*.md`.

`reports/` is gitignored — audits stay local unless the team decides otherwise.

## Where to look first

| Task                       | Start with                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| Add a storage backend      | `packages/core/src/filesystem/types.ts` + a new sibling implementation                                |
| Add an Electron capability | `packages/core/src/host/types.ts` → `desktop/main/ipc-*.ts` → `desktop/preload/preload.ts`            |
| Add a CLI command          | `packages/cli/src/commands/` + register in `packages/cli/src/index.ts`                                |
| Add a VS Code message      | `packages/core/src/vscode/messages.ts` (runtime-validated discriminated union) — handle on both sides |
| Add a shared UI component  | `packages/react/src/` — exported via `src/index.ts`                                                   |
| Add a new format converter | Linked Squisq CLI registry first; then `docs/mcp.md` and DocBlocks MCP exposure                       |
| Change theming             | `packages/react/src/styles/docblocks.css` + verify in all three surfaces and both themes              |
