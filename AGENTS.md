# AGENTS.md

Guidance for Codex (and any other AI coding agent) working in this repo. Read this first; the conventions below are load-bearing.

## What DocBlocks is

A markdown document editor and management platform that ships from one npm-workspaces monorepo to **four delivery surfaces**:

- **Site** (`packages/site`) — a Vite/React demo of the shell, deployed to GitHub Pages
- **Desktop** (`packages/desktop`) — an Electron app for macOS / Windows / Linux
- **VS Code extension** (`packages/vscode`) — a custom editor for `*.md` files plus a Setup pane
- **CLI** (`packages/cli`) — `docblocks` binary for build / serve / convert / video / mcp / parse / themes / transforms

The **site** and **desktop renderer** both mount `<DocBlocksShell>` from `@bendyline/docblocks-react` — the full chrome (file explorer, workspace picker, app menu, export pipeline). The **VS Code webview** is chrome-less: it mounts squisq's `EditorShell` directly because VS Code already provides its own file explorer, workspace, and activity bar. The actual rich-text editor in every surface is **Squisq**, published as `@bendyline/squisq*`; an optional parallel checkout lives at `..\squisq`.

## Packages

| Package            | npm name                     | Purpose                                                                                                                                                                                                                                                                                                             |
| ------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`    | `@bendyline/docblocks`       | Shared types and runtime boundary schemas. Multi-entry tsup build with filesystem backends plus `/document`, `/workspace`, `/host`, and `/vscode`. **Single source of truth for wire types.**                                                                                                                       |
| `packages/react`   | `@bendyline/docblocks-react` | `<DocBlocksShell>`, `FileExplorer`, `WorkspacePicker`, `AppMenu`, `Export*`, hooks, `styles/docblocks.css`. Consumed by site + desktop renderer. (Ships no fonts — theme fonts live in `packages/site/public/fonts/`.) (VS Code webview uses squisq's `EditorShell` directly — see the editor-shell section below.) |
| `packages/cli`     | `@bendyline/docblocks-cli`   | Commander program with 8 commands. Owns format conversion through the linked Squisq CLI registry, video rendering (Playwright + ffmpeg), and the MCP server.                                                                                                                                                        |
| `packages/vscode`  | `docblocks-vscode`           | Extension host (Node) + Vite-built React webview. Dual build: `extension.js` + `extension.web.js` for vscode.dev.                                                                                                                                                                                                   |
| `packages/desktop` | `docblocks-desktop`          | Electron — `main/` + `preload/preload.ts` + `renderer/` (Vite + React, mounts `<DocBlocksShell>`). Packaged with electron-builder.                                                                                                                                                                                  |
| `packages/site`    | `docblocks-site`             | Single-component Vite app showing `<DocBlocksShell theme="auto">`.                                                                                                                                                                                                                                                  |

## Build, test, dev commands

Node ≥22.14.0 required. PowerShell users — these all work as plain `npm` commands; no shell-specific syntax.

```bash
# The big green button — build, artifact/config checks, package consumers, guidance, static checks,
# unit/integration tests, and every E2E suite runnable on the current OS
npm run all

# Build
npm run build               # all packages in order: core → react → cli → vscode → desktop → site
npm run build:core          # one package (also :react, :cli, :vscode, :desktop)

# Dev
npm run dev                 # site workspace, preferring http://localhost:5220 (expects upstream builds)
npm run site                # build core + react, then start the site
npm run dev:desktop         # Electron + Vite concurrently on 5221
# VS Code extension: open packages/vscode in VS Code and hit F5

# Test
npm test                    # Mocha across all packages/*/test/**/*.test.ts (tsx loader)
# No package defines its own `test` script — `npm test -w <pkg>` fails with
# "Missing script". The root .mocharc.yml globs every package, and a positional
# path is ADDED to that glob rather than replacing it. To run one file:
npx mocha --no-config --require tsx --require ./packages/react/test/setup.ts <file>
npm run test:e2e            # Playwright drives the site (root config, port 5220)
npm run test:e2e:all        # all site, VS Code Web, source desktop, and packaged desktop E2E
npm run test:e2e:desktop    # Playwright + Electron launcher
npm run test:e2e:desktop:packaged # smoke the electron-builder unpacked artifact
npm run test:e2e:vscode     # Playwright + VS Code for Web (port 3100)

# Quality gates
npm run typecheck           # core, react, CLI, VS Code host + webview, site, and desktop
npm run lint                # eslint flat config
npm run format:check        # prettier
npm run format              # prettier --write

# Squisq parallel dev — symlinks @bendyline/squisq* from ..\squisq
npm run link:squisq         # link
npm run dev:squisq          # link + watch
npm run unlink:squisq       # restore registry versions
npm run test:mcp:linked     # build sibling sources, link, verify provenance/API, test MCP
npm run check:squisq-linked # require sibling links and verify MCP registry parity

# Release — multi-semantic-release per package
npm run release
```

Commits must follow Conventional Commits — commitlint enforces this in CI (pull requests and pushes to `main`); there is no local hook.

## Architecture: the seams that matter

### `DocumentSession` is the transaction boundary for active documents

`packages/core/src/document/` owns the active document lifecycle across every
surface: monotonic revisions, the single serialized commit drain, dirty/save/
error/conflict state, target transitions, retarget/delete ordering, external
observations, and close preparation. Editor instances must capture a
`{ targetKey, generation }` scope and pass it to `session.edit()` so callbacks
from an obsolete editor cannot write into a newer document.

Automatic save failures use the session's bounded retry schedule; exhaustion
remains visible as `error` with the revision still dirty. Never add an
unbounded retry loop or display manual-save success before `flush()` resolves.

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

### The CLI has one current command contract

[`docs/cli.md`](docs/cli.md) is the authoritative behavioral guide for all
`docblocks` commands: arguments, defaults, streams, filesystem effects, linked
Squisq ownership, and current format directions. Command implementation lives in
`packages/cli/src/commands/`; register each public command once in
`packages/cli/src/index.ts`. Keep the guide and the concise publishable
`packages/cli/README.md` synchronized when behavior changes.

Direct build/convert/video commands run with the invoking process's filesystem
authority and replace their documented outputs. Do not describe those commands as
having MCP root grants or conditional-write semantics. Conversely, do not bypass
the artifact-first boundary in MCP to imitate direct CLI writes.

### MCP is artifact-first and Squisq-registry-backed

[`docs/mcp.md`](docs/mcp.md) is the authoritative architecture and protocol guide.
Canonical MCP wire types and exact runtime parsers live in
`packages/core/src/mcp/`. Agent-native tools are registered from
`packages/cli/src/mcp/agentic-tools.ts`; normalization and conversion are
owned by `document-service.ts` and `conversion-service.ts`. Keep these
boundaries behind the single artifact-first surface assembled by `server.ts`;
do not add format-specific or path-writing MCP aliases.

Agent-native document sources are an exact union of bounded inline Markdown,
an opaque root ID plus canonical root-relative path, a session artifact URI,
or Markdown with explicitly listed file/artifact assets. Root IDs make paths
usable but never grant authority: startup `--allow-read` / `--allow-write`
flags remain the authority source, and physical containment is rechecked at
every read and materialization.

Conversions, bundles, and visual previews return immutable, session-scoped
`ArtifactRef`s. Binary results stay out of model context unless a client
explicitly reads the bounded `docblocks://artifacts/{id}` resource. Durable
output is a separate `save_artifact` operation: creation is no-replace, while
replacement requires the destination's current SHA-256. Server shutdown owns
artifact cleanup.

The linked Squisq CLI registry is the conversion capability source of truth.
`MCP_FORMAT_CAPABILITIES` must account for every registry format and direction
as either exposed or explicitly excluded. New conversion code calls the
linked `@bendyline/squisq-cli/api` registry; do not add another hard-coded
conversion switch. `packages/cli/test/documentation.test.ts` keeps the documented
command, tool, and format catalogs aligned with these runtime contracts.

### `<DocBlocksShell>` is the canonical editor shell — for site + desktop

Site and the desktop renderer both mount `<DocBlocksShell>`. The VS Code webview ([packages/vscode/webview/src/VscodeEditor.tsx](packages/vscode/webview/src/VscodeEditor.tsx)) is the documented exception: it mounts squisq's `EditorShell` directly because VS Code provides the file explorer, workspace, and theme via its own activity bar / API. New cross-surface UI that lives **inside the shell chrome** (file tree, workspace picker, app menu, export dialog) belongs in `packages/react/src/`. New editor-area features that need to work in vscode too either go in squisq, or get wired into both `DocBlocksShell` and `VscodeEditor` explicitly.

### Squisq is a dependency, not a fork

Editor-internal behavior (caret, selection, formatting, toolbar, plugins) lives in the optional `..\squisq` checkout and ships as `@bendyline/squisq*`. Patch upstream — never reach into `node_modules/@bendyline/squisq*` from this repo. Use `npm run link:squisq` for parallel development.

## Hard rules (enforced by ESLint or convention)

- **No `any`.** `@typescript-eslint/no-explicit-any: error` outside test files. Use proper types, generics, or `unknown` + a type guard.
- **No `console.log`.** `no-console: error` outside test files and CJS scripts. Surface errors through proper channels (VS Code `OutputChannel`, host API, CLI stderr).
- **No renderer-side Electron / Node imports.** Renderer = `packages/desktop/renderer/` + `packages/site/src/` + `packages/vscode/webview/`. These run in a browser context; importing `electron` or `node:fs` breaks the build for some surfaces and the security model for others.
- **No `vscode` import in the webview.** The VS Code webview is a sandboxed browser context. The host ↔ webview boundary is `packages/core/src/vscode/messages.ts` (runtime-validated discriminated unions) over `postMessage`.
- **Wire types live in `packages/core`.** Anything that crosses IPC, postMessage, HTTP, or MCP boundaries belongs in `core` — usually under `host/types.ts` or `filesystem/types.ts`. Surface packages should not define their own copy.
- **MCP conversion is registry-backed.** A new Squisq format or direction must flow through the linked CLI registry, update the MCP capability manifest, and pass `npm run check:squisq-linked`; never infer parity from an npm-installed copy.
- **MCP artifacts are not files or authority.** Keep conversion output session-scoped until an explicit `save_artifact`; artifact URIs must not expose physical paths, cross server instances, or bypass root grants.
- **Active-document writes go through `DocumentSession`.** UI effects and event handlers may create commit targets and observe session state, but must not run a second autosave timer or write the active document directly. All editor edits require the scope captured for that mounted document generation.
- **First-party filesystem work is v2-first.** Use branded paths, typed errors, explicit mutation modes, and capabilities. Do not add a new direct v1 mutation or a concrete-provider behavior check.
- **Filesystem absence is narrow.** Only typed `not-found` may become `null`, `false`, or an intentionally empty optional container. Never catch every storage failure and continue a backup, export, move, or save.
- **Types are not boundary validation.** Every IPC, postMessage, HTTP, MCP, argv/deep-link, and persisted-wire payload enters production code as `unknown`; accept only an exact runtime shape, reject unknown fields, and apply `core/host/wire-policy.ts` limits.
- **Paths are data, not authority.** Renderer/webview clients may send an opaque owner-scoped grant or a registered workspace ID plus a canonical `WorkspacePath`; privileged handlers must never authorize a client-provided absolute path. Display paths and labels are presentation-only.
- **Native authority is physical and revocable.** Resolve registered roots and targets with real-path containment, reject escaping symlinks/junctions and platform aliases, revalidate identity around reads, and revoke grants on navigation, renderer loss, or panel/document disposal.
- **External navigation uses one policy.** Only canonical, credential-free HTTP(S) URLs accepted by `parseExternalHttpUrl` may reach an OS browser. BrowserWindow redirects, popups, webview messages, Git helpers, and CLI output must not bypass it.
- **Privileged work is budgeted.** Bound strings, arrays, files, decoded payloads, child-process output, execution time, concurrency, and recursive traversal. A fixed argv is still unsafe if it can run forever or return unbounded data.
- **The canonical assurance gate is `npm run all`.** CI invokes it rather than copying its steps. It includes shipped-bundle budgets, desktop packaging configuration, packed public-package consumers, generated guidance freshness, all TypeScript surfaces, unit/integration tests, and every site, VS Code Web, source-desktop, and packaged-desktop E2E suite runnable on the current OS. Cross-platform CI jobs still cover desktop behavior and artifacts for the other operating systems.
- **Conventional Commits.** commitlint runs in CI on pull requests **and on pushes to `main`** — the latter matters because multi-semantic-release derives every published version bump from those exact messages. There is **no local git hook**, so a malformed message is caught in CI, not at commit time.
- **Git management is the user's job — never do it for them.** Do not create pull requests, create new branches, or create git worktrees. The user owns all branch, PR, and worktree management. Commit only when explicitly asked; otherwise leave the working tree and git state alone.

## Gotchas worth knowing

- **The `app://` custom protocol** in the Electron renderer is load-bearing. It gives IndexedDB a stable origin (so workspaces persist across launches) and lets Monaco web workers load. Don't switch to `file://`.
- **VS Code dual build.** `extension.js` runs in the Node-backed host; `extension.web.js` runs in vscode.dev. Don't let Node-only imports (`fs`, `path` with Node semantics, `child_process`) sneak into the web bundle.
- **Workspace-roots whitelist.** `packages/desktop/main/workspace-roots.ts` enforces that the renderer can only read/write inside folders the user has explicitly granted. New `ipc-fs` operations must respect it.
- **Electron workspace paths are display-only.** Filesystem, reveal, FFmpeg, and Git detection IPC accept a registered workspace ID, never `WorkspaceDescriptor.rootPath`. Export, external-file, and repository operations use owner-scoped opaque grants.
- **Electron workspace identity is main-authoritative.** New roots use canonical-path SHA-256 IDs. Main repairs legacy collisions before registering roots, and the renderer reconciles/remaps its IndexedDB descriptors from `workspaces.list()` before restoring hash or last-session state.
- **Git repository expansion is explicit.** A workspace nested in a parent repository or linked to external Git metadata requires a native main-process confirmation. Every command must use the granted, pinned `GIT_DIR` and work tree rather than rediscovering a repository from renderer input.
- **Clone cleanup owns staging only.** Reserve the final directory exclusively, clone into a hidden operation-owned staging tree, and publish with no-replace entry creation. Never recursively delete the final target on failure or cancellation.
- **Launch-file requests supersede startup navigation.** Main queues OS and second-instance argv received before a window exists; preload installs the `open-request` IPC listener before React mounts and retains a bounded FIFO backlog until the renderer subscribes. The shell claims a navigation generation as soon as each OS request arrives, before reading or decoding the resource; workspace-file requests await main-authoritative descriptor reconciliation, while async startup restoration and welcome seeding stop when that generation is superseded.
- **VS Code edits are complete coalescible snapshots.** The webview scopes every edit to its mounted host branch. Host ingress may collapse superseded client revisions into the latest snapshot, but close/save/external-change boundaries must drain that snapshot before acting.
- **CLI preview is local and allowlisted.** `docblocks serve` binds `127.0.0.1` unless network exposure is explicitly authorized, physically contains every read, and serves only documented preview asset types. Hidden paths, credentials, keys, and arbitrary repository files stay inaccessible.
- **Root mutation stays forbidden twice.** Core providers reject it semantically and Electron main rejects it again after physical root resolution. Never weaken either check.
- **Provider lifetime is explicit.** Persisted providers are retained/released by the shell; transient providers are owned by the transient registry. React effect cleanup must use the Strict-Mode-safe lease helper rather than call `dispose()` directly.
- **Squisq links need provenance verification.** `npm install` can replace the sibling symlinks with registry packages. `scripts/check-linked-squisq.ts` verifies the actual package realpaths, source/build freshness, commit/fingerprint, and registry/schema parity; run `npm run test:mcp:linked` when auditing MCP/API parity. It rebuilds and links the sibling checkout, runs the focused upstream format/media contracts, and then runs the MCP suite against that source.
- **MCP is local stdio today.** Session artifacts, root aliases, quotas, and cancellation assume one local server process. Do not describe them as remote URLs or durable jobs; a future HTTP transport requires authentication, principal isolation, Origin checks, and durable task cleanup.
- **No `AGENTS.md` per package.** Conventions live here at the root. Per-package READMEs cover package-specific scripts.
- **Mocha, not Vitest.** The test runner is Mocha (`packages/*/test/**/*.test.ts`) with `tsx` as the loader and Chai for assertions. Don't introduce a second runner.
- **Playwright covers source and shipped surfaces.** Root (`playwright.config.ts`) drives the site, `packages/desktop/e2e/playwright.config.ts` launches source Electron, the packaged desktop config boots the electron-builder artifact, and `packages/vscode/e2e/playwright.config.ts` uses VS Code for Web on port 3100.
- **`packages/react` unit tests use happy-dom + a custom `renderHook` helper.** See `packages/react/test/helpers/renderHook.ts` — it's a ~50-line wrapper around React's `act` and `createRoot`, deliberately chosen over `@testing-library/react` to keep deps small. Mocha registers happy-dom globally via `packages/react/test/setup.ts` (loaded by root `.mocharc.yml`). Active-document persistence is tested through `DocumentSession`; do not reintroduce an independent autosave hook.
- **Theme fonts are served from `packages/site/public/fonts/`** (46 woff2), not from `packages/react` — that package bundles no fonts at all. Squisq's `fontStacks` expect the host page to supply the `@font-face`s; regenerate upstream via squisq's `download-fonts.ps1`. Electron's renderer does not load them yet (known parity gap). Verify any addition is actually referenced before adding.

<!-- BEGIN GENERATED: assurance -->

## Assurance and agent skills

_This section is generated by `npm run generate:agent-guidance`; `npm run all` checks it for drift._

- Canonical local and CI gate: activate the Node major/minor pinned by `.nvmrc`, then run `npm run all`; the gate fails fast on runtime drift and success includes every repository unit/integration test and all locally runnable E2E suites on the current OS.
- Packed public-package consumer check: `npm run check:packages`.
- Assurance-contract freshness check: `npm run check:assurance`.
- All E2E suites together: `npm run test:e2e:all`.
- Individual site E2E: `npm run test:e2e`, `npm run test:e2e:browsers`, and `npm run test:e2e:offline`.
- Individual desktop source E2E: `npm run test:e2e:desktop`.
- Individual desktop packaged-artifact smoke: `npm run test:e2e:desktop:packaged`.
- Individual VS Code Web E2E: `npm run test:e2e:vscode`.
- Individual VS Code desktop extension-host E2E: `npm run test:e2e:vscode:desktop`.

Tracked repository skills:

- `/a11yreview` — source: `.agents/skills/a11yreview/SKILL.md`

`reports/` is gitignored; audit output stays local unless the team explicitly promotes it.

<!-- END GENERATED: assurance -->

## Where to look first

| Task                       | Start with                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| Add a storage backend      | `filesystem/v2.ts`, `workspace-path.ts`, `fs-error.ts`, then the shared conformance fixture           |
| Add an Electron capability | `packages/core/src/host/types.ts` → `desktop/main/ipc-*.ts` → `desktop/preload/preload.ts`            |
| Add a CLI command          | `docs/cli.md` → `packages/cli/src/commands/` → register in `packages/cli/src/index.ts`                |
| Add a VS Code message      | `packages/core/src/vscode/messages.ts` (runtime-validated discriminated union) — handle on both sides |
| Add a shared UI component  | `packages/react/src/` — exported via `src/index.ts`                                                   |
| Add a new format converter | Linked Squisq CLI registry in `..\squisq`; then `docs/mcp.md` and MCP target/fidelity exposure        |
| Change theming             | `packages/react/src/styles/docblocks.css` + verify in all three surfaces and both themes              |
