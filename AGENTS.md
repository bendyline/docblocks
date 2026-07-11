# AGENTS.md

Guidance for Codex (and any other AI coding agent) working in this repo. Read this first; the conventions below are load-bearing.

## What DocBlocks is

A markdown document editor and management platform that ships from one npm-workspaces monorepo to **four delivery surfaces**:

- **Site** (`packages/site`) — a Vite/React demo of the shell, deployed to GitHub Pages
- **Desktop** (`packages/desktop`) — an Electron app for macOS / Windows / Linux
- **VS Code extension** (`packages/vscode`) — a custom editor for `*.md` files plus a Setup pane
- **CLI** (`packages/cli`) — `docblocks` binary for init / build / serve / convert / video / mcp / parse / themes / transforms

The **site** and **desktop renderer** both mount `<DocBlocksShell>` from `@bendyline/docblocks-react` — the full chrome (file explorer, workspace picker, app menu, export pipeline). The **VS Code webview** is chrome-less: it mounts squisq's `EditorShell` directly because VS Code already provides its own file explorer, workspace, and activity bar. The actual rich-text editor in every surface is **Squisq**, a sister project that lives in `..\qualla` and ships as `@bendyline/squisq*` npm packages.

## Packages

| Package            | npm name                     | Purpose                                                                                                                                                                                                                                                       |
| ------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`    | `@bendyline/docblocks`       | Shared types. Multi-entry tsup build with subpaths: `/filesystem`, `/workspace`, `/host`. **Single source of truth for wire types.**                                                                                                                          |
| `packages/react`   | `@bendyline/docblocks-react` | `<DocBlocksShell>`, `FileExplorer`, `WorkspacePicker`, `AppMenu`, `Export*`, hooks, `styles/docblocks.css`, 17 woff2 fonts. Consumed by site + desktop renderer. (VS Code webview uses squisq's `EditorShell` directly — see the editor-shell section below.) |
| `packages/cli`     | `@bendyline/docblocks-cli`   | Commander program with 9 commands. Owns format conversion (via `squisq-formats`), video rendering (Playwright + ffmpeg), MCP server.                                                                                                                          |
| `packages/vscode`  | `docblocks-vscode`           | Extension host (Node) + Vite-built React webview. Dual build: `extension.js` + `extension.web.js` for vscode.dev.                                                                                                                                             |
| `packages/desktop` | `docblocks-desktop`          | Electron — `main/` + `preload/preload.ts` + `renderer/` (Vite + React, mounts `<DocBlocksShell>`). Packaged with electron-builder.                                                                                                                            |
| `packages/site`    | `docblocks-site`             | Single-component Vite app showing `<DocBlocksShell theme="auto">`.                                                                                                                                                                                            |

## Build, test, dev commands

Node ≥22.14.0 required. PowerShell users — these all work as plain `npm` commands; no shell-specific syntax.

```bash
# The big green button — build + lint + format:check + typecheck + test
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
npm test -w @bendyline/docblocks         # one package
npm run test:e2e            # Playwright drives the site (root config, port 5220)
npm run test:e2e:desktop    # Playwright + Electron launcher
npm run test:e2e:vscode     # Playwright + VS Code for Web (port 3100)

# Quality gates
npm run typecheck           # tsc -b core react cli + desktop
npm run lint                # eslint flat config
npm run format:check        # prettier
npm run format              # prettier --write

# Squisq parallel dev — symlinks @bendyline/squisq* from ..\qualla
npm run link:squisq         # link
npm run dev:squisq          # link + watch
npm run unlink:squisq       # restore registry versions

# Release — multi-semantic-release per package
npm run release
```

Commits must follow Conventional Commits — commitlint enforces this.

## Architecture: the seams that matter

### `DocumentSession` is the transaction boundary for active documents

`packages/core/src/document/` owns the active document lifecycle across every
surface: monotonic revisions, the single serialized commit drain, dirty/save/
error/conflict state, target transitions, retarget/delete ordering, external
observations, and close preparation. Editor instances must capture a
`{ targetKey, generation }` scope and pass it to `session.edit()` so callbacks
from an obsolete editor cannot write into a newer document.

Read the next document through `transitionWithLoad()` so the current revision
is frozen and flushed before the read begins. Rename and delete the active
document through `retarget()` / `delete()`; never change a save path from a
React effect cleanup. Production filesystem providers expose conditional
`commitFile()` semantics, and Electron close/reload/update flows must await the
renderer lifecycle acknowledgement before destroying the renderer.

Browser renderers attach a bounded synchronous `DocumentRecoveryJournal` to
the session. A draft is removed only after its revision is acknowledged; on
reopen, it is restored automatically only when the durable content still
matches the recorded baseline, otherwise it becomes an external conflict.
DBK conflicts stage the complete external bundle until the user chooses a
branch: Keep mine preserves the complete local tree, while Reload external
atomically replaces markdown and media together.

### `FileSystemProviderV2` is the storage correctness boundary

`packages/core/src/filesystem/v2.ts` defines the byte-authoritative contract.
Every built-in provider exposes a direct v2 implementation through its
temporary v1 facade:

- `MemoryFileSystemProviderV2` — transient loose-file and DBK workspaces
- `IndexedDBFileSystemProviderV2` — browser-local persistence
- `NativeFileSystemProviderV2` — browser File System Access handles
- `ElectronFileSystemProviderV2` — renderer client for the independently
  tested `NodeWorkspaceFileSystemV2` backend

`types.ts` is now only the deprecated text-oriented compatibility facade.
New first-party storage code must call `getFileSystemProviderV2()` and may use
v1 only as an explicit compatibility fallback.

The v2 invariants are load-bearing:

- `WorkspacePath` is a branded, root-relative, forward-slash path. `''` is the
  root. Parse every user/wire value with `parseWorkspacePath()`; traversal,
  control characters, and drive-qualified paths are rejected. Root can be
  read/listed but never written, moved, or removed.
- Each path has exactly one kind and one owned byte payload. Create, replace,
  parent creation, recursive removal, missing behavior, and expected versions
  are explicit options; destinations are never overwritten by move.
- Missing `stat`/`readFile` returns `null`. Permission, quota, wrong-kind,
  conflict, corruption, and I/O failures are typed `FsError`s and must never be
  translated to absence or success. IPC sends serialized errors and rehydrates
  them in the renderer.
- Callers branch on `capabilities`, never concrete provider classes, for
  atomicity, conditional-write strength, watch support, case behavior,
  symlinks, and durability.
- Multi-surface shells load concrete backends from the isolated
  `filesystem/{indexeddb,memory,native,electron}` subpaths. Keep provider
  constructors behind literal dynamic imports so mutually exclusive backends
  do not return to the site and desktop startup bundles.
- Watch subscriptions have a ready barrier, ordered typed events, overflow and
  error channels, and awaitable idempotent disposal. Provider `dispose()` owns
  all backend resources and permanently rejects new operations.
- Every provider runs
  `packages/core/test/helpers/filesystem-v2-conformance.ts`. A backend is not
  complete until it passes that suite plus backend-specific permission,
  containment, migration, watcher, and fault-injection tests.

UI code (in `packages/react`, `packages/site`, `packages/desktop/renderer`, and
`packages/vscode/webview`) **must not** call `indexedDB`, `node:fs`, or
`electron` directly. Electron main must re-parse paths and prove physical
workspace containment; renderer validation is not a security boundary.

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

Editor-internal behavior (caret, selection, formatting, toolbar, plugins) lives in `..\qualla` and ships as `@bendyline/squisq*`. Patch upstream — never reach into `node_modules/@bendyline/squisq*` from this repo. Use `npm run link:squisq` for parallel development.

## Hard rules (enforced by ESLint or convention)

- **No `any`.** `@typescript-eslint/no-explicit-any: error` outside test files. Use proper types, generics, or `unknown` + a type guard.
- **No `console.log`.** `no-console: error` outside test files and CJS scripts. Surface errors through proper channels (VS Code `OutputChannel`, host API, CLI stderr).
- **No renderer-side Electron / Node imports.** Renderer = `packages/desktop/renderer/` + `packages/site/src/` + `packages/vscode/webview/`. These run in a browser context; importing `electron` or `node:fs` breaks the build for some surfaces and the security model for others.
- **No `vscode` import in the webview.** The VS Code webview is a sandboxed browser context. The host ↔ webview boundary is `packages/vscode/src/messages.ts` (discriminated unions) over `postMessage`.
- **Wire types live in `packages/core`.** Anything that crosses IPC, postMessage, HTTP, or MCP boundaries belongs in `core` — usually under `host/types.ts` or `filesystem/types.ts`. Surface packages should not define their own copy.
- **Active-document writes go through `DocumentSession`.** UI effects and event handlers may create commit targets and observe session state, but must not run a second autosave timer or write the active document directly. All editor edits require the scope captured for that mounted document generation.
- **First-party filesystem work is v2-first.** Use branded paths, typed errors, explicit mutation modes, and capabilities. Do not add a new direct v1 mutation or a concrete-provider behavior check.
- **Filesystem absence is narrow.** Only typed `not-found` may become `null`, `false`, or an intentionally empty optional container. Never catch every storage failure and continue a backup, export, move, or save.
- **Conventional Commits.** commitlint runs on every commit.
- **Git management is the user's job — never do it for them.** Do not create pull requests, create new branches, or create git worktrees. The user owns all branch, PR, and worktree management. Commit only when explicitly asked; otherwise leave the working tree and git state alone.

## Gotchas worth knowing

- **The `app://` custom protocol** in the Electron renderer is load-bearing. It gives IndexedDB a stable origin (so workspaces persist across launches) and lets Monaco web workers load. Don't switch to `file://`.
- **VS Code dual build.** `extension.js` runs in the Node-backed host; `extension.web.js` runs in vscode.dev. Don't let Node-only imports (`fs`, `path` with Node semantics, `child_process`) sneak into the web bundle.
- **Workspace-roots whitelist.** `packages/desktop/main/workspace-roots.ts` enforces that the renderer can only read/write inside folders the user has explicitly granted. New `ipc-fs` operations must respect it.
- **Root mutation stays forbidden twice.** Core providers reject it semantically and Electron main rejects it again after physical root resolution. Never weaken either check.
- **Provider lifetime is explicit.** Persisted providers are retained/released by the shell; transient providers are owned by the transient registry. React effect cleanup must use the Strict-Mode-safe lease helper rather than call `dispose()` directly.
- **No `AGENTS.md` per package.** Conventions live here at the root. Per-package READMEs cover package-specific scripts.
- **Mocha, not Vitest.** The test runner is Mocha (`packages/*/test/**/*.test.ts`) with `tsx` as the loader and Chai for assertions. Don't introduce a second runner.
- **Playwright runs from three configs.** Root (`playwright.config.ts`) drives the site dev server. `packages/desktop/e2e/playwright.config.ts` launches Electron. `packages/vscode/e2e/playwright.config.ts` uses VS Code for Web on port 3100. Each writes to its own `test-results/`.
- **`packages/react` unit tests use happy-dom + a custom `renderHook` helper.** See `packages/react/test/helpers/renderHook.ts` — it's a ~50-line wrapper around React's `act` and `createRoot`, deliberately chosen over `@testing-library/react` to keep deps small. Mocha registers happy-dom globally via `packages/react/test/setup.ts` (loaded by root `.mocharc.yml`). Active-document persistence is tested through `DocumentSession`; do not reintroduce an independent autosave hook.
- **17 woff2 fonts** are bundled in `packages/react/src/fonts/`. Verify any addition is actually referenced before adding.

## Codex skills

Four skills live in `.Codex/skills/` — invoke with `/<name>`:

- **`/developmentarchitect`** — full or focused architecture review (duplication, type safety, build system, error handling, etc.). Writes `reports/architecture-review-*.md`.
- **`/qualitymanager`** — test-coverage and quality audit across Mocha + the three Playwright configs. Writes `reports/quality-review-*.md`.
- **`/a11yreview`** — WCAG 2.1 AA audit across site / desktop renderer / vscode webview / Setup pane. Writes `reports/a11y-review-*.md` and fixes common issues directly.
- **`/uxreview`** — visual / UX critique with explicit multi-surface parity assessment. Writes `reports/ux-review-report-*.md`.

`reports/` is gitignored — audits stay local unless the team decides otherwise.

## Where to look first

| Task                       | Start with                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| Add a storage backend      | `filesystem/v2.ts`, `workspace-path.ts`, `fs-error.ts`, then the shared conformance fixture |
| Add an Electron capability | `packages/core/src/host/types.ts` → `desktop/main/ipc-*.ts` → `desktop/preload/preload.ts`  |
| Add a CLI command          | `packages/cli/src/commands/` + register in `packages/cli/src/index.ts`                      |
| Add a VS Code message      | `packages/vscode/src/messages.ts` (discriminated union) — handle on both sides              |
| Add a shared UI component  | `packages/react/src/` — exported via `src/index.ts`                                         |
| Add a new format converter | `packages/cli/src/converters/` (and consider what belongs upstream in `squisq-formats`)     |
| Change theming             | `packages/react/src/styles/docblocks.css` + verify in all three surfaces and both themes    |
