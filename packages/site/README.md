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

This package is the live reference implementation of DocBlocks — the web surface. It mounts `<DocBlocksShell theme="auto">` from `@bendyline/docblocks-react` with the full editing experience: file explorer, workspace management, the Squisq editor with its Write and Source views and Document, Page, Slideshow, and Video previews, and multi-format export including EPUB and MP4 video. Documents persist in browser storage (IndexedDB) or in local folders granted via the File System Access API — no server, no account.

The editor remains the canonical, indexable experience at `/`. Lightweight product, format,
documentation, privacy, and terms pages live under `public/`; `robots.txt`, `sitemap.xml`, the
custom 404, canonical metadata, social metadata, and structured data are shipped with the same
build. The service-worker navigation fallback is allowlisted to `/` so it cannot replace those
static responses with the editor shell.

## Apps page and store listings

`/apps/` is the page that says where DocBlocks runs, what each app costs, and how to get it. It
replaced Desktop in the primary navigation; `/desktop/` is still the direct-download page (and the
Mac App Store listing's marketing URL), reached from `/apps/` and from every page's footer. The
store listings tell people the desktop apps are free at docblocks.com, so never remove that link.

The static pages allow no scripts, so a store going live is a markup change. Every listing that is
not live yet is a `.store-pending` plate with its live badge in a comment beside it.
`grep -rn "store:" packages/site/public` finds every place.

| Store                    | Marker                | State   | Link                                                                    |
| ------------------------ | --------------------- | ------- | ----------------------------------------------------------------------- |
| App Store (iPhone, iPad) | none                  | live    | `https://apps.apple.com/us/app/docblocks-markdown-editor/id6792768923`  |
| Google Play              | none                  | live    | `https://play.google.com/store/apps/details?id=com.bendyline.docblocks` |
| Mac App Store            | `store:mac-app-store` | pending | the App Store link above (one listing, universal purchase)              |
| Microsoft Store          | none                  | live    | `https://apps.microsoft.com/detail/9MTLPD213DL0`                        |

### When a store approves DocBlocks

1. In `public/apps/index.html` and `public/desktop/index.html`, delete that store's
   `pending` comment and plate, and uncomment the `live` badge below it.
2. Reword the sentences that say "coming to": the note under the computer cards on `/apps/`
   and the store panel on `/desktop/`. For the Mac, also add
   "One purchase covers iPhone, iPad, and Mac." to the iPhone and iPad card. Name the store in the
   trademark line at the foot of `/apps/`.
3. Add the store's offer to the `offers` list in `index.html`'s structured data.
4. Make the same change on bendyline.com (`index.html` there carries the same markers).
5. Run `npm test`. `seo.test.ts` fails if a store is both pending and live, or if `STORE_ID` is
   still in the page.

The four badges in `public/marketing/stores/` are the stores' own artwork. Size them only through
`.store-badge img`; never recolor or crop them. The phone screenshots on `/apps/` are the App Store
captures from the store kit, scaled to 640px wide.

## PWA / offline

The site ships as an installable Progressive Web App (`vite-plugin-pwa`, configured in `vite.config.ts`):

- **Full offline, automatically.** The service worker precaches the entire `dist` (~60 MiB, with an 18 MiB per-file ceiling for the ~15 MiB harper proofing binaries) in the background on the first ordinary visit — no install or user action needed. Every feature works offline from then on; documents were already local (IndexedDB / File System Access).
- **Hosted-player-compatible isolation.** Nothing shipped needs `SharedArrayBuffer`, so the app does not enable COOP/COEP: cross-origin embedder policy applies recursively and would reject supported YouTube, Vimeo, Loom, Dailymotion, and Wistia frames that do not opt into it. The root editor CSP names those exact player origins; static informational pages continue to deny frames.
- **Prompt-based updates.** New deploys surface a persistent, unobtrusive "Update available" notice (`registerType: 'prompt'`; registration + hourly update checks live in `src/pwa.ts`). Clicking it opens Reload/Later controls just above the notice; nothing opens or reloads automatically mid-edit. `public/pwa-route-migration.js` is a durable one-time exception: it activates and claims the first corrected worker for clients previously controlled by the legacy catch-all navigation fallback, then records a cache marker so all later updates return to the prompt lifecycle.
- **Install integration.** "Install DocBlocks…" appears in the app menu when the browser allows it (Chromium). Installed, the app registers as an OS handler for `.md`/`.dbk` files (`file_handlers` + the shell's `launchQueue` consumer), offers a "New document" jump-list shortcut (`/?action=new`), and draws its own title bar via Window Controls Overlay (CSS in `docblocks-react`'s `docblocks.css`, kept in sync with `packages/desktop/renderer/titlebar.css`).
- **Testing.** The SW exists only in production builds (`devOptions` off). Offline e2e runs against `vite preview` via `npm run test:e2e:offline` (root `playwright.offline.config.ts`); the default e2e config ignores `offline.spec.ts`.

### Icons

`public/favicon.png`, `public/icons/` (192/512/maskable-512/apple-touch), `public/og.png` and the wordmarks in `public/_res/siteimages/` are generated from the hull-lettering source in [`design/brand/`](design/brand/README.md). Change the letterforms or colors there and regenerate; don't edit the PNGs.

### Theme fonts

`public/fonts/` (fonts.css + 48 unique woff2 payloads, latin + latin-ext subsets) is derived from squisq's `packages/site/public/fonts` — squisq's `fontStacks` expect the host page to provide these `@font-face`s. Several upstream weight filenames contain byte-identical variable-font payloads; DocBlocks keeps one payload and points those weight declarations at it. After regenerating upstream with squisq's `download-fonts.ps1`, deduplicate the copied files before committing; `npm run check:site-fonts` enforces this. Licenses live in `public/fonts/licenses/`.

DocBlocks also bundles [Inconsolata](https://fonts.google.com/specimen/Inconsolata) for interface metadata and the Write-canvas font picker. Its Google Fonts v37 Latin and Latin Extended WOFF2 files cover weights 200–900; keep their `@font-face` rules when refreshing the upstream fonts. Copy font assets, styles and licenses to the desktop renderer, then run `npm run generate:webview-fonts` for VS Code. Mobile uses the site's public assets directly.

## Deployment

The site deploys to GitHub Pages via the `publish` workflow (`.github/workflows/publish.yml`, `deploy_pages` input).

## License

MIT
