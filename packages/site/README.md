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

## Deployment

The site deploys to GitHub Pages via the `publish` workflow (`.github/workflows/publish.yml`, `deploy_pages` input).

## License

MIT
