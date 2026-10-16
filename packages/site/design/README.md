# Site design sources

Source artwork that is **not** shipped. Anything under `packages/site/public/`
is copied verbatim into `dist/` and precached into every installed PWA, so
source files that only exist to produce a shipped asset live here instead.

- `ogbase.png` — the original Open Graph card art; `brand/og-paper.png` is its
  paper with the old wordmark removed.
- `brand/` — the hull-lettering wordmark and app icon, as code. Its README
  lists every asset it generates and how to regenerate them.
