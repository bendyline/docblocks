# docblocks-desktop

DocBlocks desktop application — an Electron shell around the DocBlocks editor for macOS, Windows, and Linux. The renderer mounts `<DocBlocksShell>` from `@bendyline/docblocks-react`, backed by real folders on disk instead of browser storage.

## Layout

Three Electron processes, three directories:

```
main/       Main process — window lifecycle, IPC handlers, menus, tray, updater
preload/    contextBridge — exposes the host API to the renderer, nothing else
renderer/   Vite + React app — mounts <DocBlocksShell>; runs in a browser context
```

Key main-process modules:

- `ipc-fs.ts` / `ipc-workspaces.ts` / `ipc-shell.ts` / `ipc-ffmpeg.ts` — IPC handlers behind the host API
- `workspace-roots.ts` — whitelist enforcement: the renderer can only read/write inside folders the user has explicitly granted. **New `ipc-fs` operations must respect it.**
- `menu.ts` / `tray.ts` — native menu and tray integration
- `updater.ts` — auto-update via electron-updater (checks this repo's GitHub Releases)
- `settings.ts`, `open-requests.ts`, `icloud-detect.ts` — persisted app settings, open-file handling, iCloud Drive detection

## Architecture rules

- **The host API is the only seam.** The contract lives in `packages/core/src/host/types.ts` (`DocBlocksHostAPI`); `main/ipc-*.ts` implements it and `preload/preload.ts` exposes it. All three must stay in sync. The renderer calls `getDocBlocksHost()` / `isElectronHost()` from `@bendyline/docblocks/host`.
- **The renderer never imports `electron` or `node:*`.** It's a browser context; everything native goes through the host API.
- **The `app://` custom protocol is load-bearing.** It gives IndexedDB a stable origin (workspaces persist across launches) and lets Monaco web workers load. Don't switch to `file://`.

## Development

```bash
# From the monorepo root
npm run app

# Or from this package
npm run dev            # Vite dev server on port 5221 + Electron, concurrently
npm run start          # launch Electron against the last build
```

## Build & package

```bash
npm run build          # renderer (Vite) + main/preload (tsup) into dist/
npm run dist           # build + electron-builder for the current platform
npm run dist:mac       # or :win, :linux, :snap, :flatpak
npm run dist:dir       # unpacked build for local inspection
```

electron-builder config is in `electron-builder.yml` (appId `com.bendyline.docblocks`, product name **DocBlocks**); artifacts land in `dist/artifacts/` named `DocBlocks-<version>-<os>-<arch>.<ext>`. App icons are regenerated with `npm run icons`.

## Testing

```bash
npm run test:e2e       # builds, then Playwright launches the packaged main process
```

The e2e fixture (`e2e/fixtures.ts`) launches the app with a throwaway `--user-data-dir` and an isolated workspace root passed via `DOCBLOCKS_E2E_DEFAULT_ROOT`, so tests never touch `DocBlocks` inside your real operating-system Documents folder. Tests cover boot, first-launch workspace bootstrap (including the seeded `aboutDocBlocks.md` welcome doc), persistence across relaunch, and the IPC path-traversal guard.

## License

MIT
