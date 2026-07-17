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

## Architecture rules

- **The host API is the only seam.** The contract lives in `packages/core/src/host/types.ts` (`DocBlocksHostAPI`); `main/ipc-*.ts` implements it and `preload/preload.ts` exposes it. All three must stay in sync. The renderer calls `getDocBlocksHost()` / `isElectronHost()` from `@bendyline/docblocks/host`.
- **The renderer never imports `electron` or `node:*`.** It's a browser context; everything native goes through the host API.
- **The `app://` custom protocol is load-bearing.** It gives IndexedDB a stable origin (workspaces persist across launches) and lets Monaco web workers load. Don't switch to `file://`.
- **Animated GIF uses the packaged browser core.** The renderer build copies the architecture-neutral pinned ffmpeg.wasm core and its GPL notices under `dist/renderer/ffmpeg-core/`; main adds COOP/COEP to trusted renderer responses so `SharedArrayBuffer` is available. The desktop runtime does not bundle a host-native FFmpeg executable. The VS Code extension deliberately does not ship these assets.

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

## Build & package

```bash
npm run build          # renderer (Vite) + main/preload (tsup) into dist/
npm run dist           # build + electron-builder for the current platform
npm run dist:mac       # or :win, :linux, :snap, :flatpak
npm run dist:dir       # unpacked build for local inspection
```

electron-builder config is in `electron-builder.yml` (appId `com.bendyline.docblocks`, product name **DocBlocks**); artifacts land in `dist/artifacts/` named `DocBlocks-<version>-<os>-<arch>.<ext>`. App icons are regenerated with `npm run icons`.

Direct-download releases include x64 and arm64 builds for macOS, Windows, and
Linux. Linux ships both AppImage and Debian packages for each architecture.

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
