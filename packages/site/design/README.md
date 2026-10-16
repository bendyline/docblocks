# Site design sources

Source artwork that is **not** shipped. Anything under `packages/site/public/`
is copied verbatim into `dist/` and precached into every installed PWA, so
source files that only exist to produce a shipped asset live here instead.

- `ogbase.png` — the original Open Graph card art; `brand/og-paper.png` is its
  paper with the old wordmark removed.
- `brand/` — the hull-lettering wordmark and app icon, as code. Its README
  lists every asset it generates and how to regenerate them.
- `capture-screenshots.mjs` — recaptures the product screenshots from the live
  app: the marketing hero (`public/marketing/docblocks-editor.png`, used on the
  Web, Desktop and Docs pages) and the two PWA install-dialog screenshots
  (`public/screenshots/`). Run `node packages/site/design/capture-screenshots.mjs`
  from the repo root; it starts and stops its own dev server.
- `capture-vscode-screenshot.mjs` — recaptures the VS Code page's hero
  (`public/marketing/docblocks-vscode.png`) in VS Code for Web. Run
  `npm run build:vscode` first, then
  `node packages/site/design/capture-vscode-screenshot.mjs`.

Recapture the screenshots after a visible change to the shell, so the first
thing a prospective user sees matches the app they get.
