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

Supported outer formats are HTML, DOCX, PDF, PPTX, and XLSX. The companion
frontmatter records the relationship without granting filesystem authority:

```yaml
---
squisq-outside-in: 1
squisq-output: ../battle-of-britain.html
squisq-output-format: html
---
```

The workspace provider and selected outer path remain authoritative. A save is
prepared by Squisq's format registry, then the active `DocumentSession` commits
the Markdown source before writing the regenerated outer file. Media uploads and
version snapshots use the companion directory directly. A conversion or output
failure therefore remains a visible dirty/error revision and can be retried; it
is never reported as a successful save.

HTML output references a shared Squisq player rather than embedding the runtime
in every page. DocBlocks searches from the document's directory toward the
workspace root for the nearest `_squisq` directory and writes
`squisq-player.js` there. If none exists, it creates the root-level runtime.
Media URLs point back to the document's companion folder.

Companion and `_squisq` directories are hidden in the user-facing explorer.
Moving or renaming a visible outside-in document carries its companion with it;
the frontmatter relationship is refreshed before the next save. Dropping a
supported rendered file into a workspace preserves that file and creates the
same companion layout instead of flattening it into a standalone Markdown file.
