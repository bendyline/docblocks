# docblocks-desktop

DocBlocks desktop application — an Electron shell around the DocBlocks editor for macOS, Windows, and Linux. The renderer mounts `<DocBlocksShell>` from `@bendyline/docblocks-react`, backed by real folders on disk instead of browser storage.

[Desktop overview and downloads](https://docblocks.com/desktop/)

## Layout

Three Electron processes, three directories:

```
main/       Main process — window lifecycle, IPC handlers, menus, tray, updater
preload/    contextBridge — exposes the host API to the renderer, nothing else
renderer/   Vite + React app — mounts <DocBlocksShell>; runs in a browser context
```

Key main-process modules:

- `ipc-fs.ts` / `ipc-workspaces.ts` / `ipc-shell.ts` — IPC handlers behind the host API
- `workspace-roots.ts` — whitelist enforcement: the renderer can only read/write inside folders the user has explicitly granted. **New `ipc-fs` operations must respect it.**
- `menu.ts` / `tray.ts` — native menu and tray integration
- `updater.ts` — auto-update via electron-updater (checks this repo's GitHub Releases)
- `settings.ts`, `open-requests.ts`, `icloud-detect.ts` — persisted app settings, open-file handling, iCloud Drive detection
- `ipc-ai.ts` + `ai/` — optional AI through an in-process private Gezel service, with the user's standalone Gezel as an optional provider switch; off until the user opts in under Settings › AI assistance

Desktop packaging downloads the signed native archives from Gezel's releases
into `resources/gezel-native/`. The `beforePack` hook calls the exact installed
`@bendyline/gezel-service/packaging` helper. Gezel selects its pinned release and
all published backends for the target architecture, verifies downloads before
extraction, and preserves the
release's license files and existing code signatures. Verified archives are
cached locally under `dist/gezel-native-cache/`; a corrupt cache fails packaging
and must be removed before retrying. Updating Gezel requires no separate native
version edit.

The text AI connector uses `connectDesktopEmbedding` from the App SDK host
entry point. Gezel owns stored-grant adoption, consent gating, private fallback,
model preparation, Apple model readiness, download observation, evidence
serialization, native verification, and host-environment restoration. DocBlocks
retains its provider-neutral `AiService`, renderer ownership, wire limits,
preferences, encrypted token storage, editor prompts/transactions, and MAS seal
verification. `withKnowledgeContext` receives the host's prompt/message limits;
model locality comes from SDK metadata, never from an engine name.

These APIs ship in the pinned Gezel App SDK `1.1.4` and service `1.2.4`.
Use the local link workflow below for further sibling development. The
connector reports a missing runtime if the required SDK export is absent.
See Gezel's `docs/handboek/technical/docblocks-text-ai-with-gezel.md` for the
request flow and code examples.

Kokoro narration uses Gezel core `1.2.4`'s `planKokoroSpeech` export
from `@bendyline/gezel/kokoro`, which preserves word/source ranges for the
timestamped ONNX model. The model pin itself uses an existing upstream artifact
and requires no new native
engine build. See [speech timing](../../docs/speech.md#kokoro-export-and-model-updates).

Inference fixes, including MLX's Python prompt builder, ship in
`@bendyline/gezel-service`. Updating only `@bendyline/gezel-app-sdk` or the user's
standalone Gezel does not update DocBlocks' private hosted service. To adopt an
upstream fix, publish the corrected service, update the desktop's exact service
pin and lockfile (and any companion packages required by that release), rebuild,
and restart DocBlocks. Do not patch the installed package's Python files.
MLX's launcher loads the script from the service bundle when starting the
engine; existing model weights can be reused.

For local development against `../gezel`, run `npm run link:gezel` from the
DocBlocks root. This links the desktop's SDK, service, and core contracts to that
checkout, preserving the installed packages for `npm run unlink:gezel`.
`npm run check:gezel-linked` prints the actual package paths and checks their
built entry points. Linking does not change release pins or the lockfile.

`npm run all` (through `build`'s preflight), `npm run build`, and desktop dev
startup rebuild linked Gezel's SDK/service runtime dependency graph in order,
under Gezel's shared dependency-read lease. No dependencies are installed and
registry-only checkouts continue to use their pinned packages, including after
`npm install` replaces all local links. A leftover link marker does not require
the sibling checkout. `npm run unlink:gezel` clears the old configuration while
preserving any packages npm has already installed; saved copies restore only
packages that are still linked or missing. A partial link set or mixed checkouts
still fail the build. The build includes copied Python assets; it never
restarts a running Electron process. Restart the desktop app after rebuilding
to load the current backend. `npm run build:gezel-linked` runs this step alone.

When evaluating reasoning settings, verify the rendered model prompt as well as
the SDK request. Service `1.2.3` dropped `chat_template_kwargs` on text-only MLX
requests without tools or images: `reasoning_effort: 'none'` reached Gezel but
the model still started in a thinking block. The stream splitter assumed the
requested setting had applied, so thinking appeared as draft text. The upstream
`prompt_reasoning_test.py` regression covers this path. Compare omitted effort
with `none` only after adopting the fix, keeping the writing prompt, model,
sampling settings, and output budget the same.

Writing requests (compose and rewrite) omit a fixed output-token cap. For local
MLX, llama.cpp, Ollama, and DS4 models, the connector requests the reported
context capacity instead of falling back to a short catalog response budget;
reasoning tokens count toward that same capacity. Remote providers and models
without reported capacity keep their provider defaults. Model/context limits
still apply, and generated text shares DocBlocks' normal document-size boundary.
The draft dialog warns before requests estimated to exceed the selected model's
reported context, including room for a comparable rewrite and thinking. This is
an advisory text-size estimate, not tokenizer accounting or a universal context
size; a local runtime may configure less context than the model advertises.
Exact, unique selections are sent once rather than duplicated in the document
context. Write-view selections use Squisq's optional `EditorSelectionInfo.markdown`
so headings, block annotations, inline formatting, and tables reach the model;
the plain-text selection remains the readable preview. Older editors fall back
to `text`. A truncated or interrupted draft stays editable and offers **Continue
draft**, which sends the original task plus the entire edited draft and appends
the response. Continuation does not discard source to make a request fit, and
may also reach the model's limit. Choose a smaller section or a larger-context
model when this happens. Known incomplete drafts require confirmation before
insertion or replacement; continuing and then applying is still one editor
undo step.
Writing also omits `reasoning_effort` so Gezel can use the selected model's
defaults. It can take longer to produce the first visible text, but reasoning
remains separate from the draft. Chat, review, and diagram
requests retain `none` until those tasks have their own quality and budget
comparisons. The connector's real-SDK tests pin both policies.

Draft dialogs request `stream_options.include_progress` alongside usage. Gezel's
opt-in `gezel_progress` chunks carry request-local loading, queue, prefill,
reasoning, and writing status; percentages and token counters are shown only
when measured by the engine. These chunks contain no prompt or reasoning text
and remain separate from draft content and terminal events. Older services fall
back to elapsed time and received characters. Full phase reporting requires the
Gezel service progress extension, either built through the local links above or
released and adopted using the service pin/rebuild procedure; widening the SDK
types alone does not enable it in an already installed service. The connector
also validates the extension when using the current SDK's pass-through stream
parser.

After AI opt-in, the hosted service checks the complete native file set, SHA-256
hashes, symlinks, and platform signatures against its own source-bundled pins,
using the directory supplied as the SDK's `host.nativeBinDir` before the service
starts. Every packaged build uses `distributionProfile: 'store'`, so missing or invalid engines
fail visibly instead of triggering executable downloads. Model weights remain
data downloads initiated by **Add model**. Development may use an absolute
`DOCBLOCKS_GEZEL_NATIVE_BIN_DIR`; it receives the same native file verification
without requiring a notarized enclosing app. With no development override, Gezel
may provision engines as before.

macOS distributions support Apple Silicon only. Mac App Store builds include
AI through a private service inside `userData/ai/gezel`, with standalone Gezel
discovery and external model borrowing disabled. AI remains off until opt-in.
The first MAS implementation offers Apple Intelligence through the bundled
Foundation Models helper and downloaded GGUF weights through llama.cpp/Metal.
Apple readiness failures remain visible in Settings. ML Kit GenAI is an Android
provider, not a macOS API. MLX is withheld in packaged builds until a frozen
Python runtime is bundled; bundling UV alone does not supply that runtime.

MAS packaging first verifies the upstream native pins, moves executables into
`Contents/Helpers` and Metal libraries into `Contents/Frameworks`, and preserves
their logical resource paths with sealed symlinks. It signs executables with
sandbox inheritance and libraries with the app identity and no entitlements.
The enclosing app seals a manifest of the resulting bytes. Local builds verify
those hashes exactly. App Store delivery changes code signatures; only an
authenticated Apple store signing certificate and complete app resource seal
permit changed hashes. Runtime also verifies native locations, symlinks,
signatures and executable inheritance. Direct macOS builds preserve the upstream
Developer ID signatures.

The service pin `1.2.4` selects notarized native release `0.1.48`.
Signed MAS build and runtime qualification remain separate release gates.
See [the native release handoff](../../docs/desktop-ai-native-release.md).

## Knowledge catalogs in AI settings

The desktop AI bridge exposes optional `host.ai.knowledge` inventory and actions.
Settings lists installed catalogs, offers curated downloads and updates, shows
progress and failures, and lets users enable, disable, or confirm removal of a
catalog. Catalogs belong to the connected provider: switching between built-in
AI and standalone Gezel switches the catalog registry. Removal from standalone
Gezel affects other apps using that registry. Catalog downloads require explicit
gestures. When the provider reports that a one-time model download would improve
results (a catalog is enabled and that model is missing), Settings shows a single
link, "Improve knowledge results with a 23 MB model download"; choosing it starts
the download, and the link does not return once it is running or installed.
Opening Settings or querying never starts it, and the UI never calls the model a
reranker.

Writing, review, and chat all call the SDK's `knowledge.retrieve` before
inference and leave ranking to the SDK: Gezel ranks passages with the relevance
model when it is installed and otherwise returns only what its own bar for
unranked catalog hits admits. Retrieved passages are bounded against the prompt
budget, marked as untrusted evidence, and retain their catalog/version
citations. Knowledge never blocks a request: when retrieval fails or answers
with anything malformed, the request goes without passages and the main process
logs one warning. No enabled catalogs or no matches produces an empty reference
context. Gezel's bundled Handboek is never offered to apps. Catalog installation
can prepare its embedding model as part of that
explicit download. Mobile hosts without this optional SDK capability do not
expose catalog management.

The pinned App SDK `1.1.4` and service `1.2.4` provide the `knowledge` grant and
`/v1/knowledge/{state,update,retrieve}`. Existing inference-only grants require
reconnection with the typed verification code; silent reconnect must never
open a consent prompt.

## Architecture rules

- **The host API is the only seam.** The contract lives in `packages/core/src/host/types.ts` (`DocBlocksHostAPI`); `main/ipc-*.ts` implements it and `preload/preload.ts` exposes it. All three must stay in sync. The renderer calls `getDocBlocksHost()` / `isElectronHost()` from `@bendyline/docblocks/host`.
- **The renderer never imports `electron` or `node:*`.** It's a browser context; everything native goes through the host API.
- **The `app://` custom protocol is load-bearing.** It gives IndexedDB a stable origin (workspaces persist across launches) and lets Monaco web workers load. Don't switch to `file://`.
- **No FFmpeg is distributed.** The renderer once packaged the pinned ffmpeg.wasm core under `dist/renderer/ffmpeg-core/`; that build is GPL-2.0-or-later and could not be reconciled with the Mac App Store's terms, so it was removed from every surface. Video export runs on WebCodecs plus the MIT-licensed `mp4-muxer`; Animated GIF is no longer offered in the editor and remains a CLI/MCP capability backed by a system FFmpeg binary. `ipc-ffmpeg.ts` still _detects_ a host-native FFmpeg but the desktop runtime never bundles one. Main still adds COOP/COEP to trusted renderer responses, now purely as hardening.

## Development

```bash
# From the monorepo root
npm run app

# Or from this package
npm run dev            # Vite dev server on port 5221 + Electron, concurrently
npm run start          # launch Electron against the last build
```

Source launches use a separate `DocBlocks-dev` Electron profile and always
start on `DocBlocks-dev` inside the operating system's Documents folder. This
keeps installed-app settings, registered workspaces, and last-document state
out of development while leaving the development workspace persistent across
restarts. An explicit `--user-data-dir` still overrides the development
profile for one-off isolated runs.

Main/preload changes rebuild on disk but **do not restart the running app**.
Save recordings and documents, then restart `npm run dev:desktop` to load those
changes. The watcher prints a reminder after each rebuild. This keeps unsaved
recordings in the renderer alive while code is edited.

Screen recording asks which screen or application window to share before
previewing. On supported macOS versions Electron uses the system picker;
elsewhere a native menu lists **Screens** and **Application windows**.
Dismissal cancels capture; it never selects the primary monitor automatically.
The recording dialog's **What to record** controls offer a whole surface or a
coordinate region, measured in captured pixels from that surface's top-left.
Region capture crops the preview and saved video, with audio unchanged.

## Build & package

Workspace file reads and writes support **1 GiB per file**. The renderer uses
4 MiB IPC chunks and main stages transfers on disk before committing through
the normal filesystem provider. Incomplete transfers never replace the target.
Transfers are scoped to the renderer/provider, expire after two idle minutes
(15 minutes total), and allow at most four active transfers with 2 GiB of spool
reservations. Individual legacy IPC messages and complete workspace snapshots
retain their separate 100 MiB budgets.

The shared recorder stops at **900 MiB total** across recording tracks and
keeps final encoder chunks intact. This is a soft threshold: delayed encoder
output can exceed it. The review dialog shows the size and provides media and
timing backup downloads, including after a failed document save. Capture is
still held in renderer memory until saved or downloaded; it is not crash-durable.

```bash
npm run build          # renderer (Vite) + main/preload (tsup) into dist/
npm run dist           # build + electron-builder for the current platform
npm run dist:mac       # or :win, :linux, :snap, :flatpak
npm run dist:dir       # unpacked smoke build for local inspection
```

electron-builder config is in `electron-builder.yml` (appId `com.bendyline.docblocks`, product name **DocBlocks**); artifacts land in `dist/artifacts/` named `DocBlocks-<version>-<os>-<arch>.<ext>`. App icons are regenerated with `npm run icons`.

On macOS, `dist:dir` disables the hardened runtime for its ad-hoc-signed local
artifact. Ad-hoc signatures have no common Team ID, so hardened library
validation otherwise rejects Electron Framework before the app can start.
Installers and release builds continue to use the hardened runtime and the
normal signing and notarization configuration.

Direct-download releases include Apple Silicon builds for macOS and x64 and
arm64 builds for Windows and Linux. Linux ships both AppImage and Debian packages
for each architecture.

## Testing

```bash
npm run test:e2e                 # fast source-build Electron flows
npm run test:e2e:packaged        # package with electron-builder, then smoke the real app
npm run test:e2e:packaged:only   # smoke an existing dist/artifacts unpacked package
```

The source fixture (`e2e/fixtures.ts`) launches `dist/main/main.cjs` with a
throwaway `--user-data-dir` and an isolated workspace root passed via
`DOCBLOCKS_E2E_DEFAULT_ROOT`, so tests never touch `DocBlocks` inside your real
operating-system Documents folder or the persistent `DocBlocks-dev` workspace.
Both directories are removed after each test. Those tests cover boot, first-launch
workspace bootstrap, persistence across relaunch, and the IPC path-traversal
guard. Automation also exits when its final window closes on macOS and uses a
forced process fallback after a bounded graceful shutdown, so a failed launch
cannot leave a headless Electron process or Playwright worker behind.

The packaged smoke uses `e2e/playwright.packaged.config.ts`. It resolves the
current platform's electron-builder `--dir` output, verifies `app.asar` and the
production Electron fuse wire, launches that executable, and checks the
sandboxed renderer and shell over renderer CDP. It deliberately does not use
Playwright's Electron launcher: that launcher requires the Node inspector,
which the production `EnableNodeCliInspectArguments` fuse disables. Set
`DOCBLOCKS_PACKAGED_EXECUTABLE` to smoke a previously downloaded unpacked
artifact rather than `dist/artifacts`.

## License

MIT
