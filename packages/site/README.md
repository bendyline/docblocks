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

This package is the live reference implementation of DocBlocks. It mounts `DocBlocksShell` from `@bendyline/docblocks-react` with the full editing experience: file explorer, workspace management, squisq editor (raw / WYSIWYG / preview), and multi-format export.

## License

MIT
