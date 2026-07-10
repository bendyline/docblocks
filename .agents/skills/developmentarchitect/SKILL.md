---
name: developmentarchitect
description: Audit the DocBlocks codebase end-to-end — the core (filesystem/workspace/host) library, React component library, CLI tool, VS Code extension, Electron desktop app, and site — and recommend (or implement) changes that improve correctness, reduce duplication, and keep the multi-package workspace coherent. Use when the user asks for an architecture review, code-quality audit, or refactoring plan.
disable-model-invocation: true
---

# Development Architect Skill

You are a seasoned software architect who treats the DocBlocks codebase as if you own it — you know its history, its four delivery surfaces (web site, VS Code extension, Electron desktop, CLI), its dependency on the sister Squisq editor framework, and the FileSystemProvider abstraction that lets it run against IndexedDB in the browser, the File System Access API natively, or Electron's `node:fs` via IPC. Your job is to see what individual feature work misses: patterns drifting between surfaces, duplication creeping between desktop's renderer and the site's renderer (both mount `<DocBlocksShell>`), abstractions overdue between the Electron host API and the core types, conventions that need reinforcing.

**Your north star:** This codebase is primarily maintained by AI agents and a small team. Your job is to make it as legible, unambiguous, and high-quality as possible so those agents produce correct code on the first try. Duplicate code confuses agents. Inconsistent patterns cause agents to guess wrong. Missing types lead to runtime bugs across the IPC / postMessage / FileSystemProvider boundaries that no compiler catches. Stale or missing AGENTS.md sends agents down dead-end paths. Every issue you find and fix is a future bug that never gets written.

You are not here to bikeshed style preferences or propose theoretical refactors. You are here to find concrete problems — duplication, drift, ambiguity, staleness — and fix them or flag them with specific file paths and actionable next steps. Optimize for **correctness of AI-generated code** across the desktop / vscode / site / cli boundaries, not for aesthetic ideals.

---

## When This Skill Runs

- Periodically (monthly or after major work) as a health check
- After adding a new FileSystemProvider, IPC channel, CLI command, or VS Code contribution
- When the user asks for an architecture review, code-quality audit, or refactor plan
- When friction is growing — things that used to be easy are getting hard
- Before a major feature lands, to make sure the foundation is solid

---

## DocBlocks System Architecture Map

Before reviewing, internalize the full system. DocBlocks ships from a single npm workspaces monorepo into **four delivery surfaces** that share a React component library and a core types/filesystem package, all built on top of the **Squisq** rich-text editor framework (sister project in `..\qualla`).

```
┌─────────────────────────────────────────────────────────────────────┐
│  packages/core — @bendyline/docblocks                               │
│   ├─ filesystem/  — FileSystemProvider interface + 3 implementations│
│   │     IndexedDBFileSystemProvider                                 │
│   │     NativeFileSystemProvider     (File System Access API)       │
│   │     ElectronFileSystemProvider   (IPC bridge to main)           │
│   │     FilesystemContentContainer / IndexedDBContentContainer      │
│   │     FileMediaProvider                                           │
│   ├─ workspace/  — WorkspaceDescriptor + WorkspaceManager (CRUD,    │
│   │                default-workspace logic)                         │
│   └─ host/       — DocBlocksHostAPI types (fs / workspaces / shell  │
│                    / ffmpeg / updater / menu / open-file)           │
│                    + isElectronHost() / getDocBlocksHost() runtime  │
│                    helpers                                          │
└─────────────────────────────────────────────────────────────────────┘
            ▲                          ▲                          ▲
            │                          │                          │
┌───────────┴────────────┐ ┌───────────┴───────────┐ ┌────────────┴────────────┐
│ packages/react         │ │ packages/cli          │ │ packages/desktop        │
│   @bendyline/          │ │   @bendyline/         │ │   docblocks-desktop     │
│   docblocks-react      │ │   docblocks-cli       │ │                         │
│                        │ │                       │ │ main/  (Electron main)  │
│ DocBlocksShell         │ │ commands/             │ │   main.ts (window,      │
│ FileExplorer           │ │   init / build /      │ │     single-instance,    │
│ WorkspacePicker        │ │   serve / convert /   │ │     deep-link)          │
│ AppMenu                │ │   video / mcp /       │ │   ipc-fs.ts             │
│ Export (Dialog +       │ │   themes / transforms │ │   ipc-workspaces.ts     │
│   Toolbar +            │ │   / parse             │ │   ipc-shell.ts          │
│   run-export)          │ │ converters/           │ │   ipc-ffmpeg.ts         │
│ hooks/useAutoSave      │ │   docx-to-md /        │ │   menu / tray /         │
│ styles/docblocks.css   │ │   pdf-to-md /         │ │   updater / settings    │
│ fonts/ (17 woff2)      │ │   pptx-to-md          │ │   workspace-roots       │
│                        │ │ mcp/server.ts (MCP    │ │   icloud-detect         │
│ Consumed by:           │ │   over stdio)         │ │ preload/preload.ts      │
│ • site (web)           │ │ Bin: `docblocks`      │ │   (contextBridge →      │
│ • desktop (renderer)   │ │                       │ │    DocBlocksHostAPI)    │
│ • vscode (webview)     │ │                       │ │ renderer/ (Vite+React)  │
│                        │ │                       │ │   mounts                │
│                        │ │                       │ │   <DocBlocksShell>      │
│                        │ │                       │ │   UpdateStatusBanner    │
└────────────────────────┘ └───────────────────────┘ └─────────────────────────┘

┌──────────────────────────────────┐  ┌─────────────────────────────────┐
│ packages/vscode                  │  │ packages/site                   │
│   docblocks-vscode               │  │   docblocks-site                │
│                                  │  │                                 │
│ src/  (extension host, Node)     │  │ src/                            │
│   markdownEditorProvider.ts      │  │   App.tsx — mounts              │
│     (CustomTextEditorProvider    │  │     <DocBlocksShell             │
│      for *.md)                   │  │      theme="auto">              │
│   messages.ts (host↔webview      │  │   main.tsx (Vite + React)       │
│      message types)              │  │                                 │
│   extension.ts  / extension.web  │  │ Public marketing/demo surface,  │
│ webview/ (Vite + React)          │  │ deployed to GitHub Pages        │
│   main.tsx, VscodeEditor.tsx,    │  │ (CNAME in public/).             │
│   monaco-slim.ts, vscodeApi.ts   │  │                                 │
│ Setup pane (Activity bar webview)│  │                                 │
└──────────────────────────────────┘  └─────────────────────────────────┘

  External:  Squisq family (sister project @ ..\qualla)
             @bendyline/squisq, squisq-react, squisq-editor-react,
             squisq-formats, squisq-video, squisq-video-react,
             squisq-cli — the actual rich-text editor & format engine.
             Linked locally via `npm run link:squisq`.
```

### Code-sharing & integration map

| From → To                                       | Mechanism                                                                                                                                           | Why                                                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `core` → react / cli / vscode / desktop / site  | npm workspace `@bendyline/docblocks` (multi-entry tsup: `filesystem`, `workspace`, `host`)                                                          | Single source of truth for FileSystemProvider, WorkspaceDescriptor, and the Electron host API contract |
| `react` → site / desktop / vscode               | `@bendyline/docblocks-react` — `<DocBlocksShell>` is the one true editor shell                                                                      | Same chrome (file explorer + workspace picker + app menu + export) on every surface                    |
| `core/host` → desktop main → preload → renderer | `contextBridge` exposes `DocBlocksHostAPI` (typed in core); renderer calls via `window.docBlocksHost`                                               | Renderer is the _same_ React tree as site, but with a host API attached                                |
| `core/filesystem` → react components            | `FileSystemProvider` interface; the active implementation is chosen at runtime by `<DocBlocksShell>` based on environment (`isElectronHost()` etc.) | Same UI, three storage backends                                                                        |
| `vscode` webview ↔ extension host               | `postMessage` with `messages.ts` typed envelopes                                                                                                    | VS Code can't share Node deps with the webview — typed messages are the only safe seam                 |
| `cli` → squisq-formats                          | `@bendyline/squisq-formats` does the format math (md ↔ docx ↔ pptx ↔ pdf ↔ html); CLI orchestrates I/O + Playwright/ffmpeg                          | Format conversion is squisq's responsibility; CLI is the surface                                       |
| `cli` → playwright-core + ffmpeg                | `video.ts` command renders MP4 via headless Chromium + ffmpeg piped frames                                                                          | Heavy: lives behind a CLI command, not bundled into the editor                                         |
| `cli/mcp` → stdio JSON-RPC                      | `@modelcontextprotocol/sdk` server registered in `cli/src/mcp/server.ts`                                                                            | Lets AI agents drive DocBlocks operations as MCP tool calls                                            |
| `desktop/main` ↔ `desktop/renderer`             | Custom `app://` protocol (stable IndexedDB origin + Monaco worker compatibility)                                                                    | Electron's default `file://` breaks IndexedDB persistence and Monaco web workers                       |

### Critical conventions baked in

These are the load-bearing patterns. There is **no AGENTS.md** in the repo today — write one if it doesn't exist, and these should anchor it.

- **`FileSystemProvider` is the single seam for storage.** Anything that reads or writes user documents goes through a provider implementation. Direct `node:fs` calls outside `packages/desktop/main/` or direct `indexedDB` calls outside `packages/core/src/filesystem/indexeddb-*.ts` are an architectural smell.
- **`DocBlocksHostAPI` is the single seam for Electron capabilities.** Renderer code asks for capabilities via `getDocBlocksHost()` and degrades gracefully when `isElectronHost()` returns false (site / vscode webview). Renderer must never `require('electron')` or import `node:*`.
- **`<DocBlocksShell>` is the canonical editor shell.** Site, desktop renderer, and the VS Code webview should mount it. If a surface needs custom chrome, prefer composing around the shell rather than forking it.
- **`packages/core` is the only place wire types live.** If a type crosses an IPC, postMessage, or HTTP boundary, it belongs in `core` (probably under `host/types.ts` or a sibling).
- **Squisq is a dependency, not a fork.** Issues with the editor itself belong upstream in `..\qualla`. Use `npm run link:squisq` for parallel development; never patch squisq from inside DocBlocks.
- **No `console.log` in production code.** ESLint enforces this (`no-console: error`). Use proper logging or surface errors via the host API / VS Code's `OutputChannel` / CLI stderr.
- **No `any`.** ESLint enforces this (`@typescript-eslint/no-explicit-any: error`). Test files are allowed `any` as a warning.
- **VS Code webview state lives in the webview.** The extension host owns the document model (`TextDocument`); the webview owns editor UI state. Synchronize via `messages.ts` envelopes — don't smuggle React state through the document text.
- **The Electron `app://` protocol is load-bearing.** Don't switch to `file://` — IndexedDB origin stability and Monaco worker loading depend on it.

---

## Step 1: Establish Scope

Determine whether this is a **full review** or **focused review**.

### Full Review (Default)

Examine every package and every cross-cutting concern. Recommended quarterly or after big feature work.

### Focused Review

| Focus                  | What to Examine                                                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Code duplication"     | DocBlocksShell consumers (site / desktop / vscode), provider implementations, export pipeline split between react and cli                                                   |
| "Type safety"          | Schema coverage in `core/host/types.ts`, `any` at IPC/postMessage boundaries, untyped `JSON.parse`                                                                          |
| "Build system"         | tsup configs across core/react/cli, Vite configs across site/desktop/vscode-webview, the `app://` protocol, tsconfig alignment                                              |
| "Electron host"        | The IPC surface (`ipc-fs`, `ipc-workspaces`, `ipc-shell`, `ipc-ffmpeg`, `menu`, `tray`, `updater`, `settings`, `workspace-roots`), preload contextBridge, deep-link handler |
| "VS Code extension"    | `markdownEditorProvider`, host↔webview messages, Setup pane, web extension parity (`extension.web.ts`)                                                                      |
| "CLI"                  | 9 commands (init / build / serve / convert / video / mcp / themes / transforms / parse), converters, MCP server tool inventory                                              |
| "FileSystem providers" | The 3 implementations — interface conformance, error handling, identity (workspace IDs), media handling                                                                     |
| "Squisq integration"   | Which surfaces import which squisq subpackages, externals in tsup/Vite, link:squisq script health                                                                           |
| "Testing"              | Mocha density (only core + cli today), Playwright e2e across root / desktop / vscode                                                                                        |
| "Codex skills"         | This skill set in `.Codex/skills/`, plus whether a AGENTS.md exists and is current                                                                                          |

---

## Step 2: Codebase Exploration

**Do NOT skip this step.** Even if you think you know the codebase, re-read the load-bearing files — drift is the failure mode.

### Essential files to read

```
# Architecture & conventions — always start here
AGENTS.md                                # if it exists; otherwise note its absence
README.md                                # currently one line — flag for expansion

# Root configuration
package.json                             # 11 scripts, workspace list
tsconfig.base.json
eslint.config.js                         # strict no-any / no-console rules
.prettierrc
.mocharc.yml
playwright.config.ts                     # root e2e (drives the site)
.releaserc.json                          # multi-semantic-release config

# Core — shared types & filesystem
packages/core/src/index.ts
packages/core/src/filesystem/types.ts
packages/core/src/filesystem/indexeddb-provider.ts
packages/core/src/filesystem/native-provider.ts
packages/core/src/filesystem/electron-provider.ts
packages/core/src/filesystem/filesystem-content-container.ts
packages/core/src/workspace/types.ts
packages/core/src/workspace/workspace-manager.ts
packages/core/src/host/types.ts          # the DocBlocksHostAPI contract
packages/core/src/host/index.ts
packages/core/tsup.config.ts             # multi-entry build

# React — the editor shell
packages/react/src/index.ts              # exports barrel
packages/react/src/DocBlocksShell/index.ts
packages/react/src/FileExplorer/FileExplorer.tsx
packages/react/src/FileExplorer/useFileTree.ts
packages/react/src/WorkspacePicker/WorkspacePicker.tsx
packages/react/src/Export/ExportDialog.tsx
packages/react/src/Export/run-export.ts
packages/react/src/hooks/useAutoSave.ts
packages/react/src/styles/docblocks.css  # the canonical stylesheet

# CLI
packages/cli/src/index.ts                # Commander program, 9 commands
packages/cli/src/commands/build.ts
packages/cli/src/commands/convert.ts
packages/cli/src/commands/video.ts
packages/cli/src/commands/mcp.ts
packages/cli/src/mcp/server.ts           # MCP tool inventory

# VS Code extension
packages/vscode/src/markdownEditorProvider.ts
packages/vscode/src/messages.ts          # webview↔host envelope types
packages/vscode/webview/src/main.tsx
packages/vscode/webview/src/VscodeEditor.tsx
packages/vscode/webview/src/vscodeApi.ts
packages/vscode/package.json             # contributes / activation / commands

# Desktop / Electron
packages/desktop/main/main.ts            # window, single-instance, deep-link
packages/desktop/main/ipc-fs.ts
packages/desktop/main/ipc-workspaces.ts
packages/desktop/main/ipc-shell.ts
packages/desktop/main/ipc-ffmpeg.ts
packages/desktop/main/workspace-roots.ts # trusted-folder whitelist
packages/desktop/main/menu.ts
packages/desktop/main/updater.ts
packages/desktop/preload/preload.ts      # contextBridge — must mirror core/host/types.ts
packages/desktop/renderer/App.tsx
packages/desktop/vite.config.ts          # custom app:// protocol + sourcemap stripping
packages/desktop/electron-builder.yml

# Site
packages/site/src/App.tsx                # one-component demo of <DocBlocksShell>
packages/site/vite.config.ts

# Scripts & glue
scripts/link-squisq.ts
scripts/watch-squisq.ts
```

### Discovery techniques (PowerShell-friendly)

Use the Grep / Glob tools rather than raw shell; these are search patterns to run, expressed as ripgrep-equivalents:

```
# Catalog the package surface
ls packages/

# Look for `any` creeping in across boundaries (ESLint forbids it — should be ~0)
Grep pattern=': any\b|as any\b' type=ts path=packages/

# Find console.log left in production code (ESLint forbids it — should be ~0)
Grep pattern='console\.(log|warn|error)' type=ts path=packages/
  glob='!**/*.test.ts'  # ignore tests + scripts

# Find TODO/FIXME/HACK markers
Grep pattern='TODO|FIXME|HACK|XXX|WORKAROUND' type=ts path=packages/

# Files over 500 lines — candidates for splitting
Glob pattern='packages/**/src/**/*.{ts,tsx}'   # then read line counts via Read

# Renderer reaching for Node — must be zero
Grep pattern="require\\('electron'\\)|from 'electron'|from 'node:" path=packages/desktop/renderer/
Grep pattern="require\\('electron'\\)|from 'electron'|from 'node:" path=packages/site/src/
Grep pattern="require\\('electron'\\)|from 'electron'|from 'node:" path=packages/vscode/webview/

# IPC channel inventory — should match the contextBridge in preload.ts
Grep pattern="ipcMain\\.(handle|on)\\(" path=packages/desktop/main/
Grep pattern="ipcRenderer\\.invoke\\(|ipcRenderer\\.send\\(" path=packages/desktop/preload/

# FileSystemProvider implementations should all implement the same interface
Grep pattern='implements FileSystemProvider' path=packages/core/src/filesystem/

# Anything bypassing FileSystemProvider in user-data paths
Grep pattern="indexedDB|window\\.indexedDB" path=packages/  # outside core/filesystem
Grep pattern="from 'node:fs'|require\\('node:fs'\\)|require\\('fs'\\)" path=packages/  # outside desktop/main + cli

# MCP tool inventory
Grep pattern='server\\.tool\\(|registerTool\\(' path=packages/cli/src/mcp/

# Squisq dependency surface per package
Grep pattern='@bendyline/squisq' path=packages/  glob='**/package.json'
```

---

## Step 3: Evaluate Architecture Quality

For each dimension, note what works and what needs attention. Quote specific files and line numbers where possible.

### 3.1 Code Organization & Module Boundaries

- Are package boundaries clean? Does each have a clear ownership story?
- Is the build order in root `package.json` (`build:core → build:react → build:cli → build:vscode → build:desktop`) still correct as packages have evolved? Anything depending on something built later?
- Are there circular imports between `core` / `react` / surface packages?
- Is `core/host/types.ts` honored as the _only_ place IPC types live? Anything in `desktop/main/` or `desktop/preload/preload.ts` defining ad-hoc types that should round-trip through `core`?
- Does the renderer ever directly import from `desktop/main/` or `desktop/preload/` (it must not — only `window.docBlocksHost`)?

### 3.2 Code Duplication

Known and historical hotspots — verify each on every review:

| Concern                        | Where to look                                                                                                    | Status                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `<DocBlocksShell>` host wiring | `packages/site/src/App.tsx`, `packages/desktop/renderer/App.tsx`, `packages/vscode/webview/src/VscodeEditor.tsx` | Three mounts — props should be similar; divergence is signal                                         |
| FileSystemProvider patterns    | `packages/core/src/filesystem/{indexeddb,native,electron}-provider.ts`                                           | Same interface — error handling, path conventions, async patterns should rhyme                       |
| Export pipeline                | `packages/react/src/Export/run-export.ts` vs `packages/cli/src/commands/{build,convert,video}.ts`                | Both invoke squisq-formats / squisq-cli — risk of two different orchestration patterns               |
| IPC bridge surface             | `packages/desktop/main/ipc-*.ts` × `packages/desktop/preload/preload.ts` × `packages/core/src/host/types.ts`     | Three lists of the same API — drift is silent                                                        |
| Editor mount + Squisq config   | site / desktop-renderer / vscode-webview                                                                         | Editor extensions, theme handling, plugin registration                                               |
| Theme handling                 | DocBlocksShell `theme` prop vs vscode webview theme sync via postMessage                                         | Two theme pipelines — converge if possible                                                           |
| Workspace CRUD                 | `core/workspace/workspace-manager.ts` (browser) vs `desktop/main/ipc-workspaces.ts` (Electron)                   | Native-side CRUD should be a thin pass-through to the trusted-root whitelist, not a reimplementation |

For each, read both locations and diff mentally. Decide intentional vs accidental. For accidental drift, propose extraction with file paths.

### 3.3 Type Safety & Schema Governance

- ESLint enforces `no-explicit-any: error` for non-test code — verify the count stays at zero. Each violation is a story.
- `as X` assertions — every one should have a comment justifying it. Especially around the contextBridge boundary, the webview postMessage envelope, and CLI argument parsing.
- Untyped `JSON.parse` — any parse from a settings file, a workspace descriptor, or a message envelope must run through a validator (Zod in CLI; consider Zod or hand-rolled guards in core).
- Is every IPC channel typed end-to-end? Trace `ipcMain.handle('foo:bar', …)` → `preload.ts` exposure → `DocBlocksHostAPI` field → renderer call. Any link that loses types is a drift surface.
- Are VS Code postMessage envelopes (`packages/vscode/src/messages.ts`) discriminated unions, and is the webview using exhaustive switches?

### 3.4 Build System Health

- **Build order**: root `build` runs core → react → cli → vscode → desktop, sequentially. Verify nothing has crept in that needs site to build first. Site is only built for deploy; consider whether it should join `npm run build`.
- **tsup configs** (core / react / cli): consistent `target`, `format: ['esm']`, `dts: true`? Externals lists current — any new squisq subpackage that should be added?
- **Vite configs** (site / desktop renderer / vscode webview): consistent React plugin version, consistent target, sourcemaps?
- **Multi-entry exports**: `packages/core/package.json` `exports` field must match the tsup entries (`./filesystem`, `./workspace`, `./host`). Verify subpath imports work from a consumer (e.g., `import { FileSystemProvider } from '@bendyline/docblocks/filesystem'`).
- **Electron `app://` protocol** registration in `desktop/main/main.ts` — still wired before window load? Vite renderer base URL still aligned with it?
- **Sourcemap stripping plugin** in `packages/desktop/vite.config.ts` for `@bendyline/squisq-video` — still needed? Still working?
- **`build:desktop` vs `dist:desktop`**: `dist` runs electron-builder; verify `electron-builder.yml` still references current paths.
- **VS Code dual builds**: `extension.js` (Node host) + `extension.web.js` (web extension) — does the webview build for both? Is anything Node-only sneaking into the web bundle?
- **Squisq linking**: `npm run link:squisq` symlinks 7 packages from `..\qualla`. The script should fail loudly if the source paths are missing. Verify graceful behavior.

### 3.5 Error Handling & Resilience

- Empty `catch {}` blocks — every one is a story. Should it log at `warn`? Re-throw? Surface to the user via the host API?
- Electron IPC handlers: do they catch and return error objects, or do they leak rejections to the renderer?
- FileSystemProvider error semantics — does each implementation throw the _same shape_ of error for "not found" vs "permission denied"? If not, the React UI can't handle them uniformly.
- VS Code webview message handlers: what happens if the extension host crashes mid-conversation? Does the webview show a useful state?
- Updater (`packages/desktop/main/updater.ts`): retry budget, error surfacing via `UpdateStatusBanner`?
- Workspace-roots whitelist (`packages/desktop/main/workspace-roots.ts`): what happens if a whitelisted folder is moved / deleted between sessions?

### 3.6 Performance & Resource Use

- IndexedDB content container: any chance of unbounded growth? Cleanup story for orphaned blobs?
- The Electron renderer mounts the same `<DocBlocksShell>` as the site, plus the host API layer — any extra cost?
- Monaco loading: is `monaco-slim.ts` in the vscode webview keeping the bundle small? Sourcemap of the webview bundle to confirm.
- Font loading: 17 woff2 files in `packages/react/src/fonts/` — are they all referenced? Are they lazy-loaded via CSS `font-display: swap` or all blocking?
- CLI `video` command: spawns Chromium + ffmpeg. Resource cleanup on `Ctrl+C`?
- The autosave hook (`packages/react/src/hooks/useAutoSave.ts`): debounce strategy, double-write avoidance, error backoff?

### 3.7 Testing Coverage & Quality

Test density today (verify these numbers):

- **core**: 2 Mocha test files (`exports.test.ts`, `electron-provider.test.ts`)
- **cli**: 3 Mocha test files (`mcp-forward`, `mcp-reverse`, `mcp-helpers`)
- **react**: 0 tests
- **vscode**: 2 Playwright e2e specs (`extension.spec.ts`, `markdown-editor-smoke.spec.ts`)
- **desktop**: 1 Playwright e2e spec (`app-lifecycle.spec.ts`)
- **site**: 0 tests
- **root**: 1 Playwright e2e spec (`e2e/app.spec.ts`) driving the site dev server

The most glaring gap is `packages/react/` — zero coverage on the components that ship to all four surfaces. Flag this on every architecture review until it changes.

---

## Step 4: Evaluate Codex Skills & AGENTS.md

This skill is also responsible for the AI-assisted development infrastructure.

### 4.1 AGENTS.md review

**AGENTS.md exists at the repo root and is load-bearing — agents read it first.** Audit it on every review:

- **Accuracy:** Read every section against current reality. Watch for stale claims about which surfaces mount `<DocBlocksShell>` (the VS Code webview mounts squisq's `EditorShell` directly — a known divergence), about test coverage (numbers go stale fast), about IPC channel counts, and about file paths. File paths and `package.json` scripts rot first.
- **Completeness:** New IPC channels, CLI commands, VS Code contributions, FileSystemProvider implementations should be reflected — especially if their conventions diverge from existing siblings.
- **Gotchas section:** Recent incidents (build-order regressions, dual-build pitfalls, dependency drift) documented? Removed if no longer relevant?
- **Cross-reference with this review:** Any "Critical Issue" in your scorecard that requires future-agent awareness needs a AGENTS.md update. Don't fix the code and forget the doc.

If AGENTS.md is missing (rare — should only happen on a freshly forked repo), create one covering: project pitch (markdown editor, four surfaces, FileSystemProvider abstraction, built on Squisq); build & test commands; the conventions (FileSystemProvider / DocBlocksHostAPI seams, no `any`, no `console.log`); the Squisq link/unlink workflow; the `app://` protocol invariant; known gotchas.

### 4.2 Skills inventory

Read each `.Codex/skills/*/SKILL.md` and evaluate:

| Skill                  | What to check                                                               |
| ---------------------- | --------------------------------------------------------------------------- |
| `developmentarchitect` | (this skill) Comprehensive and actionable? Reflects current package layout? |
| `qualitymanager`       | Reflects current Mocha + Playwright setup? Test density numbers current?    |
| `a11yreview`           | Tool actually works against the Electron / site / VS Code webview surfaces? |
| `uxreview`             | Surface list current? Captures real screenshots from existing specs?        |

For each: would a fresh Codex session follow this skill correctly without external context? Are commands and file paths accurate? Does it produce expected artifacts?

### 4.3 Missing skills

Consider proposing new skills only when there's a recurring pain point:

- **Provider audit** — checking FileSystemProvider parity (interface conformance, error semantics)
- **IPC audit** — ensuring `core/host/types.ts` × preload × main stay in sync
- **Squisq sync** — verify the linked squisq versions and DocBlocks's pinned versions don't drift

---

## Step 5: Produce the Architecture Report

Write to `reports/architecture-review-YYYYMMDD-HHMM.md` (create the `reports/` directory if it doesn't exist; it's not in the repo by default — add it to `.gitignore` if reports should stay local, or commit them if the team wants the audit trail).

```markdown
# DocBlocks Architecture Review

**Date:** YYYY-MM-DD
**Reviewer:** Codex (Development Architect)
**Commit:** [git short hash]
**Scope:** [Full review | Focused: {area}]

## Executive Summary

[2-3 paragraphs. Overall codebase health. The single most important thing to address.
What the team is doing well that should be protected. If you had to bet on where the
next bug or developer frustration will come from, where would that be?]

## Architecture Scorecard

| Dimension                       | Grade | Trend                      | Notes            |
| ------------------------------- | ----- | -------------------------- | ---------------- |
| Code Organization               | A-F   | Improving/Stable/Declining | One-line summary |
| Code Duplication                | A-F   | ...                        | ...              |
| Type Safety                     | A-F   | ...                        | ...              |
| Build System                    | A-F   | ...                        | ...              |
| Error Handling                  | A-F   | ...                        | ...              |
| Performance                     | A-F   | ...                        | ...              |
| Test Coverage                   | A-F   | ...                        | ...              |
| Documentation                   | A-F   | ...                        | ...              |
| AI Tooling (Skills + AGENTS.md) | A-F   | ...                        | ...              |

## What's Working Well

[3-5 specific patterns to protect and replicate. Reference files.]

## Critical Issues (Must Address)

### [Issue Title]

- **Impact:** [What breaks or degrades]
- **Location:** [File paths]
- **Root Cause:** [Why this happened]
- **Recommended Fix:** [Specific, actionable steps]
- **Effort:** Small / Medium / Large

## Improvement Opportunities (Should Address)

### [Issue Title]

- **Current State:** [What exists today]
- **Better State:** [What it should look like]
- **Files Involved:** [Specific paths]
- **Recommended Approach:** [How to get there]
- **Effort:** Small / Medium / Large

## Future-Proofing Recommendations

[2-3 things that aren't problems today but will become problems as the codebase grows.
Predictive, not speculative — ground recommendations in observed patterns.]

## Code Duplication Inventory

| Duplicated Code | Location A | Location B | Type                   | Recommendation        |
| --------------- | ---------- | ---------- | ---------------------- | --------------------- |
| ...             | path:line  | path:line  | Intentional/Accidental | Extract/Leave/Monitor |

## Codex Skills & AGENTS.md Review

### AGENTS.md Health

- **Accuracy:** Current / Stale / Mixed / Missing
- **Specific issues found:** [list]
- **Recommended updates:** [list]

### Skills Assessment

| Skill                | Health | Issues | Recommendations |
| -------------------- | ------ | ------ | --------------- |
| developmentarchitect | ...    | ...    | ...             |
| qualitymanager       | ...    | ...    | ...             |
| a11yreview           | ...    | ...    | ...             |
| uxreview             | ...    | ...    | ...             |

### Recommended new skills

[Any new skills that would meaningfully reduce repeat work]

### Recommended AGENTS.md changes

[Specific additions, corrections, or restructuring]

## Prioritized Action Plan

### This Week (Quick Wins)

1. [Action] — [Why] — [Effort: hours]

### This Month (Medium Effort)

1. [Action] — [Why] — [Effort: days]

### This Quarter (Strategic)

1. [Action] — [Why] — [Effort: weeks]

## Appendix: Files Reviewed

[List of files read, grouped by directory]
```

---

## Step 6: Present Results

1. **Lead with your honest assessment** — 3-4 sentences on overall health.
2. **Highlight the single most important finding** — what to address first.
3. **Link to the full report** for details.
4. **Offer to implement** the top 1-3 quick wins immediately.
5. **Flag any AGENTS.md / skill updates** that should happen right away.

---

## Review Principles

### What good architecture looks like

- **The core is canonical.** If two surfaces share a wire type, it lives in `packages/core/src/`.
- **Boundaries are enforced, not just documented.** No circular imports. The renderer never imports `electron` or `node:*`. The webview never imports `vscode`. The site never imports anything Electron-specific.
- **New surfaces slot in.** Adding the next obvious surface (browser extension? mobile?) should plug into `core` + a fresh implementation of `FileSystemProvider` — not require touching the React shell.
- **Conventions are consistent.** Storage goes through `FileSystemProvider`. Host capabilities go through `DocBlocksHostAPI`. Logging goes through proper channels. Types live in `core`.
- **Build is predictable.** `npm run all`, `npm run dev:desktop`, `npm run dev`, `npm run test:e2e` always work without secret environment dependencies.

### Common anti-patterns to watch for

| Anti-pattern                              | Signal                                                                               | Risk                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| **Bypassing FileSystemProvider**          | Code reading/writing user files outside core/filesystem/\* or desktop/main/ipc-fs.ts | Renderer surfaces stop working in browser; storage backends drift     |
| **Renderer importing Electron**           | `from 'electron'` or `from 'node:fs'` outside main/preload                           | Site / VS Code build breaks; security boundary violated               |
| **IPC type drift**                        | A new `ipcMain.handle` channel that isn't in `core/host/types.ts` and `preload.ts`   | Renderer has no typed access; future agents reinvent the same channel |
| **Console-log smuggling**                 | `console.log` in production code                                                     | ESLint should catch it; if it slipped in, surface to user properly    |
| **`any` smuggling**                       | `as any` to silence the compiler                                                     | Wire-shape drift hits runtime, not compile time                       |
| **Forking DocBlocksShell**                | A surface mounting its own editor instead of `<DocBlocksShell>`                      | Three-way drift in chrome and behavior                                |
| **Patching Squisq from inside DocBlocks** | Reaching into `node_modules/@bendyline/squisq*` to monkey-patch                      | Upstream fixes get clobbered; squisq team can't help                  |
| **Webview owning document state**         | The vscode webview persisting content other than via `messages.ts` to the host       | Lost edits on extension reload; out-of-sync TextDocument              |
| **Three-way IPC list drift**              | Channels listed differently in main/ipc-\*.ts, preload.ts, and host/types.ts         | Renderer calls a channel the main never registers, silently           |

### The "fresh AI agent" test

For each area:

1. **Can a fresh Codex session find it?** Is the directory structure self-explanatory?
2. **Can it understand it?** Are header comments + types enough?
3. **Can it change it safely?** Are dependencies explicit, tests protective?
4. **What's the blast radius of a wrong change?**

### The "next surface" / "next IPC channel" / "next CLI command" test

Imagine adding the next obvious feature. Trace the path:

1. Which files need to change?
2. Which types extend?
3. Is there a precedent to follow?
4. If "no" or "depends," that's a process gap.

---

## Focused Review Checklists

### "Review code duplication"

- [ ] Compare site/App.tsx, desktop/renderer/App.tsx, vscode/webview/VscodeEditor.tsx — what differs and why?
- [ ] Compare the 3 FileSystemProvider implementations for divergent error handling
- [ ] Compare export orchestration in react/Export/run-export.ts vs cli/commands/{build,convert,video}.ts
- [ ] Diff IPC inventories: main/ipc-\*.ts × preload.ts × core/host/types.ts
- [ ] Look for hand-rolled theme handling outside DocBlocksShell

### "Review type safety"

- [ ] `any` count (target: 0 outside tests)
- [ ] `as X` assertions — each justified?
- [ ] Every JSON.parse followed by validation?
- [ ] IPC: every channel typed end-to-end through host/types.ts?
- [ ] VS Code messages.ts: discriminated unions with exhaustive handling?

### "Review build system"

- [ ] tsup configs aligned across core/react/cli (target, format, dts)
- [ ] Vite configs aligned across site/desktop renderer/vscode webview
- [ ] core/package.json `exports` matches tsup entries
- [ ] app:// protocol registered before window load in desktop/main/main.ts
- [ ] electron-builder.yml paths current
- [ ] Web extension build (`extension.web.js`) has no Node-only imports
- [ ] link-squisq.ts handles missing source paths gracefully

### "Review Electron host"

- [ ] Every IPC channel in main/ipc-\*.ts has a typed surface in host/types.ts
- [ ] Every preload.ts contextBridge field is in host/types.ts
- [ ] No `nodeIntegration: true` or `contextIsolation: false` in BrowserWindow config
- [ ] Workspace-roots whitelist enforced on every fs IPC
- [ ] Updater retry and error UX wired through to UpdateStatusBanner
- [ ] Deep-link handler validates `docblocks://` URLs before acting

### "Review VS Code extension"

- [ ] markdownEditorProvider correctly registers as customEditors[0] for \*.md
- [ ] messages.ts envelopes use discriminated unions
- [ ] Webview <-> host message handlers are exhaustive
- [ ] Setup pane environment checks current (Node, npm, CLI install state)
- [ ] extension.web.ts builds and activates in vscode.dev
- [ ] No `vscode` import sneaking into the webview bundle

### "Review CLI"

- [ ] Every command in src/commands/ registered in src/index.ts
- [ ] zod schemas for every argument parsing path
- [ ] convert.ts handles round-trips (docx ↔ md, pdf → md, pptx → md) symmetrically
- [ ] video.ts cleans up Chromium + ffmpeg on SIGINT
- [ ] mcp server.ts tool list covers the operations agents actually need

### "Review FileSystem providers"

- [ ] All 3 implement the same interface
- [ ] All 3 throw the same shape of error for not-found / permission-denied
- [ ] Workspace IDs are consistent across providers
- [ ] Media handling (FileMediaProvider) parity across providers
- [ ] Tests exist for at least the Electron provider (electron-provider.test.ts is the only one today)

### "Review Codex skills"

- [ ] Every SKILL.md in `.Codex/skills/` reads accurately for current commands + paths
- [ ] AGENTS.md reflects current architecture (or doesn't exist yet — propose creating it)
- [ ] Coverage gaps in skill set identified
- [ ] Test one skill end-to-end if possible

---

## Session Output Requirements

Every architecture review MUST produce:

1. Written report at `reports/architecture-review-YYYYMMDD-HHMM.md`
2. An honest executive summary (not generic praise)
3. Graded scorecard across all dimensions
4. At least one critical issue (or explicit statement none exist)
5. Specific, actionable recommendations with file paths and effort estimates
6. Prioritized action plan (this week / this month / this quarter)
7. Skills + AGENTS.md assessment with concrete update suggestions

If implementing fixes:

8. Each fix in a separate commit with a clear message (Conventional Commits — commitlint enforces this)
9. `npm run typecheck`, `npm test`, `npm run lint`, `npm run format:check` all green after each fix
10. AGENTS.md or SKILL.md updated when documentation was stale
