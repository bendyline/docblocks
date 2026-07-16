# docblocks-site

Demo and documentation website for DocBlocks, built with Vite and React.

## Development

```bash
# From the monorepo root
npm run dev

# Or directly
npm run dev -w docblocks-site
```

The dev server prefers `http://localhost:5220` and uses the next free port when it is busy.

## Build

```bash
npm run build -w docblocks-site
```

Output goes to `dist/`. Preview with:

```bash
npm run preview -w docblocks-site
```

## What it does

This package is the live reference implementation of DocBlocks — the web surface. It mounts `<DocBlocksShell theme="auto">` from `@bendyline/docblocks-react` with the full editing experience: file explorer, workspace management, the Squisq editor with its Editor / Markdown / Play views, and multi-format export including EPUB and Animated GIF. Documents persist in browser storage (IndexedDB) or in local folders granted via the File System Access API — no server, no account.

The editor remains the canonical, indexable experience at `/`. Lightweight product, format,
documentation, privacy, and terms pages live under `public/`; `robots.txt`, `sitemap.xml`, the
custom 404, canonical metadata, social metadata, and structured data are shipped with the same
build. The service-worker navigation fallback is allowlisted to `/` so it cannot replace those
static responses with the editor shell.

## PWA / offline

The site ships as an installable Progressive Web App (`vite-plugin-pwa`, configured in `vite.config.ts`):

- **Full offline, automatically.** The service worker precaches the entire `dist` (~55 MB, with a 32 MiB per-file ceiling for the 31 MiB pinned ffmpeg.wasm core) in the background on the first ordinary visit — no install or user action needed. Every feature works offline from then on; documents were already local (IndexedDB / File System Access).
- **Animated GIF on static hosting.** Dev and preview send COOP/COEP directly. The custom Workbox service worker adds the same headers to cached responses so GitHub Pages becomes cross-origin isolated after its first offline install and reload; the UI asks for that one-time reload if GIF is opened sooner.
- **Prompt-based updates.** New deploys surface an immediate Reload/Later card plus a persistent "Update available" notice (`registerType: 'prompt'`; registration + hourly update checks live in `src/pwa.ts`). Nothing auto-reloads mid-edit. `public/pwa-route-migration.js` is a durable one-time exception: it activates and claims the first corrected worker for clients previously controlled by the legacy catch-all navigation fallback, then records a cache marker so all later updates return to the prompt lifecycle.
- **Install integration.** "Install DocBlocks…" appears in the app menu when the browser allows it (Chromium). Installed, the app registers as an OS handler for `.md`/`.dbk` files (`file_handlers` + the shell's `launchQueue` consumer), offers a "New document" jump-list shortcut (`/?action=new`), and draws its own title bar via Window Controls Overlay (CSS in `docblocks-react`'s `docblocks.css`, kept in sync with `packages/desktop/renderer/titlebar.css`).
- **Testing.** The SW exists only in production builds (`devOptions` off). Offline e2e runs against `vite preview` via `npm run test:e2e:offline` (root `playwright.offline.config.ts`); the default e2e config ignores `offline.spec.ts`.

### Icons

`public/icons/` (192/512/maskable-512/apple-touch) are generated from `public/_res/siteimages/docblk.webp` — regenerate with any canvas-based resize if the logo changes (content within the central ~80% for the maskable variant, solid background).

### Theme fonts

`public/fonts/` (fonts.css + 46 unique woff2 payloads, latin + latin-ext subsets) is derived from squisq's `packages/site/public/fonts` — squisq's `fontStacks` expect the host page to provide these `@font-face`s. Several upstream weight filenames contain byte-identical variable-font payloads; DocBlocks keeps one payload and points those weight declarations at it. After regenerating upstream with squisq's `download-fonts.ps1`, deduplicate the copied files before committing; `npm run check:site-fonts` enforces this. Licenses live in `public/fonts/licenses/`.

## Deployment

The site deploys to GitHub Pages via the `publish` workflow (`.github/workflows/publish.yml`, `deploy_pages` input).

## License

MIT
