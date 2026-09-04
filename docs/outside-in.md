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

Companion and `_squisq` directories are hidden in the user-facing explorer.
Moving or renaming a visible outside-in document carries its companion with it;
the frontmatter relationship is refreshed before the next save. Dropping a
supported rendered file into a workspace preserves that file and creates the
same companion layout instead of flattening it into a standalone Markdown file.
Common source, plaintext, data, and image files are copied byte-for-byte under
their original name. A rejected file type produces an error instead of being
silently omitted from the drop.
