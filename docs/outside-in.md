# Outside-in editing

Outside-in editing keeps a rendered document as the file people see and share,
while treating Markdown as its durable editable source. Opening a supported
rendered file in a DocBlocks workspace imports it once, then mounts its companion
Markdown in Squisq on every later open.

For example:

```text
battle-of-britain.html
battle-of-britain_files/
  battle-of-britain.md
  hero.jpg
  .versions/
_squisq/
  squisq-player.js
```

The corresponding convention for `Tucson.pptx` is
`Tucson_files/tucson.md`. The outer filename and companion directory preserve
the user's casing; the Markdown filename is a stable lowercase slug.

Supported outer formats are HTML, DOCX, PDF, PPTX, XLSX, and CSV. The companion
frontmatter records the relationship without granting filesystem authority:

```yaml
---
squisq-outside-in: 1
squisq-output: ../battle-of-britain.html
squisq-output-format: html
---
```

CSV and XLSX imports keep the original data file bytes as a sidecar referenced
by a small companion Markdown document instead of expanding rows into Markdown
tables. CSV uses a parse-free import path; XLSX reads the workbook structure to
preserve sheet and region addresses in its reference blocks. This
keeps large files beyond the inline table limits usable through virtualized
data cards. Both formats initially open in block-at-a-time mode so the active
data card fills the editing viewport.

The imported companion initially opens read-only. Choosing **Allow editing via
markdown** from the rendered file's context menu first copies the byte-exact
original to `<stem>_files/.original/original.<format>`, using create-only
semantics so a later opt-in can never replace the restoration point. It then
adds the exact boolean authorization flag:

```yaml
squisq-updatefrommarkdown: true
```

Only that boolean value enables Markdown-driven regeneration; missing, string,
or false values remain read-only.

The explorer's **New File** form creates Markdown by default and can instead
create a Word document, Excel workbook, PDF document, or Web page. A new
rendered document starts with both its visible file and an editable, already
opted-in Markdown companion, so every save immediately regenerates the visible
file. New Web pages have two choices recorded in companion frontmatter as
`squisq-html-output`: `interactive` emits the document data plus the shared
Squisq player, while `static` emits conventional semantic HTML with no player
or JavaScript. Existing imported HTML without this setting retains the legacy
player-backed outside-in behavior.

The workspace provider and selected outer path remain authoritative. A save is
prepared by Squisq's format registry, then the active `DocumentSession` commits
the Markdown source before writing the regenerated outer file. Media uploads and
version snapshots use the companion directory directly. A conversion or output
failure therefore remains a visible dirty/error revision and can be retried; it
is never reported as a successful save.

Interactive HTML output references a shared Squisq player rather than embedding
the runtime in every page. DocBlocks searches from the document's directory
toward the workspace root for the nearest `_squisq` directory and writes
`squisq-player.js` there. If none exists, it creates the root-level runtime.
Both Web page variants resolve media back to the document's companion folder.

A static page (with or without a page template) runs no script, so each save
settles what the player would draw: Mermaid and ASCII diagrams, timelines,
drawings, and charts are drawn as pictures embedded in the page; icons become
small inline SVGs, so the page needs no icon font; audio and video files get
native players; a table that points at a data file shows its first 100 rows;
`{[…]}` block tags are left out rather than printed; and links to files in the
companion folder resolve from the page. File trees stay text. Word, PDF, and
PowerPoint files get pictures of the diagrams and charts they cannot draw, as
the Export dialog does, and show data tables the same way. A save redraws only
the diagrams it changed.

A workspace default theme (`documents.defaultTheme` in
[workspace settings](workspace-settings.md)) styles regenerated pages whose
companion names no theme of its own; a page picks up a changed default the
next time it is saved. A workspace catalog lists each outside-in document by
its rendered file, described from its companion Markdown.

## Page templates

A static Web page can be generated inside a page of your own — a site header,
navigation, links home, a footer, and your stylesheet — instead of DocBlocks'
plain page. Write that page once as an ordinary HTML file, the **page
template**, and mark where the content goes with the HTML standard's `<slot>`
element:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title><slot name="title">Post</slot> · My Blog</title>
    <meta name="description" content="" />
    <link rel="stylesheet" href="../css/site.css" />
  </head>
  <body>
    <header><a href="../index.html">My Blog</a></header>
    <article>
      <h1><slot name="title">Post title</slot></h1>
      <time><slot name="date"></slot></time>
      <slot>Post content goes here.</slot>
    </article>
    <footer>…</footer>
  </body>
</html>
```

- The one unnamed `<slot>` receives the page content. `<slot/>` works too.
- `<slot name="title">` receives the page title: frontmatter `title`, else the
  first heading, else the file name. `<slot name="KEY">` receives the
  companion's frontmatter `KEY` (`date`, `author`, …) as text. A slot with no
  value shows its own children, so the template previews sensibly when opened
  directly in a browser.
- `<title>` text, `<meta name="description">`, and existing `og:` / `twitter:`
  title and description tags are filled in from the document.
- Relative links and sources in the template are rewritten for each page's
  folder, so `../css/site.css` written next to `_templates/post.html` still
  works from `posts/2026/hello.html`. URLs inside inline `<style>` or `style=""`
  are not rewritten; use root-relative URLs or a linked stylesheet there.
- The template's own stylesheet styles the page. DocBlocks adds only the small
  stylesheet its content features need (feature sections, video embeds, SVG
  illustrations, icons), before the template's styles so they win.
- Everything else in the template, including scripts and comments, is copied
  unchanged. The content sits between `<!-- squisq:content -->` markers, so
  re-importing a generated page imports only the content.

A page chooses its template in **Document settings** (the gear in the
editor toolbar): the **Page template** field lists the workspace default,
None, and every page template DocBlocks finds in the workspace. It appears for
editable static Web pages and imported pages, not interactive ones. The choice
is stored in the companion frontmatter, where it can also be written by hand:

```yaml
squisq-output-template: /_templates/post.html
```

A leading `/` starts at the workspace root; any other path is relative to the
companion Markdown, like `squisq-output`. `none` opts the page out of the
workspace default. Otherwise the workspace's `documents.outputTemplates.html`
(see [workspace settings](workspace-settings.md)) applies to every static Web
page, including imported pages that predate the `squisq-html-output` choice.
Interactive pages render through the Squisq player and never use a template;
naming one for them is an error.

A missing or unusable template — no unnamed slot, unbalanced slots, a path
outside the workspace — fails the save with a message naming the template.
Nothing is written, so the published page never loses its chrome; fix the
template or the path and the edit saves.

HTML files that contain a `<slot>` outside any `<template>` element are page
templates: DocBlocks opens them as HTML source in the code editor instead of
importing them, keeps a dropped template byte-for-byte, and leaves templates
out of workspace catalogs. Saving a template in DocBlocks regenerates every
editable page generated through it, rewriting only pages whose output changed
and never touching their Markdown; a template edited elsewhere reaches a page
the next time that page is saved.

Companion and `_squisq` directories are hidden in the user-facing explorer.
Moving or renaming a visible outside-in document carries its companion with it;
the frontmatter relationship is refreshed before the next save. Dropping a
supported rendered file into a workspace preserves that file and creates the
same companion layout instead of flattening it into a standalone Markdown file.
Common source, plaintext, data, and image files are copied byte-for-byte under
their original name. A rejected file type produces an error instead of being
silently omitted from the drop.
