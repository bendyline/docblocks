# docblocks-site

Demo and documentation website for DocBlocks, built with Vite and React.

## Development

```bash
# From the monorepo root
npm run dev

# Or directly
npm run dev -w docblocks-site
```

The dev server starts at `http://localhost:5220`.

## Build

```bash
npm run build -w docblocks-site
```

Output goes to `dist/`. Preview with:

```bash
npm run preview -w docblocks-site
```

## What it does

This package is the live reference implementation of DocBlocks — the web surface. It mounts `<DocBlocksShell theme="auto">` from `@bendyline/docblocks-react` with the full editing experience: file explorer, workspace management, the Squisq editor with its Editor / Markdown / Play views, and multi-format export. Documents persist in browser storage (IndexedDB) or in local folders granted via the File System Access API — no server, no account.

## PWA / offline

The site ships as an installable Progressive Web App (`vite-plugin-pwa`, configured in `vite.config.ts`):

- **Full offline, automatically.** The service worker precaches the entire `dist` (~22 MB, `maximumFileSizeToCacheInBytes` raised to 10 MiB so the 6 MB Monaco ts.worker fits) in the background on the first ordinary visit — no install or user action needed. Every feature works offline from then on; documents were already local (IndexedDB / File System Access).
- **Prompt-based updates.** New deploys surface as an "Update available" notice at the lower-right of the editor status bar. Clicking it opens the shell's Reload/Later prompt (`registerType: 'prompt'`; registration + hourly update checks live in `src/pwa.ts`). Nothing auto-reloads mid-edit.
- **Install integration.** "Install DocBlocks…" appears in the app menu when the browser allows it (Chromium). Installed, the app registers as an OS handler for `.md`/`.dbk` files (`file_handlers` + the shell's `launchQueue` consumer), offers a "New document" jump-list shortcut (`/?action=new`), and draws its own title bar via Window Controls Overlay (CSS in `docblocks-react`'s `docblocks.css`, kept in sync with `packages/desktop/renderer/titlebar.css`).
- **Testing.** The SW exists only in production builds (`devOptions` off). Offline e2e runs against `vite preview` via `npm run test:e2e:offline` (root `playwright.offline.config.ts`); the default e2e config ignores `offline.spec.ts`.

### Icons

`public/icons/` (192/512/maskable-512/apple-touch) are generated from `public/_res/siteimages/docblk.webp` — regenerate with any canvas-based resize if the logo changes (content within the central ~80% for the maskable variant, solid background).

### Theme fonts

`public/fonts/` (fonts.css + 96 woff2, latin + latin-ext subsets) is a copy of squisq's `packages/site/public/fonts` — squisq's `fontStacks` expect the host page to provide these `@font-face`s. Regenerate upstream with squisq's `download-fonts.ps1` and re-copy; licenses live in `public/fonts/licenses/`.

## Deployment

The site deploys to GitHub Pages via the `publish` workflow (`.github/workflows/publish.yml`, `deploy_pages` input).

## License

MIT
