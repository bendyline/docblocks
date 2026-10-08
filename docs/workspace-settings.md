# Workspace settings

Some settings belong to a folder rather than to an app install: the theme
every article in a folder should use, a catalog page that lists those
articles, a data file describing them, and whether DocBlocks keeps version
history for them. DocBlocks keeps these in the folder itself, so they travel
with it through git, sync clients, and workspace downloads:

```text
<workspace root>/
  .docblocks/
    workspace.json
```

The explorer hides `.docblocks/`, like every dot-folder.

## Editing

- **Site, desktop, mobile:** the workspace gear menu › **Workspace
  settings…**, or **Settings › Version history › This workspace's
  settings…**. Changes are drafted and written once on **Save**.
- **VS Code:** the editor's gear › **This folder**, saved with **Save folder
  settings**. VS Code also validates and completes hand edits to
  `.docblocks/workspace.json` against the bundled JSON Schema.
- **By hand:** the file is plain JSON. DocBlocks re-reads it when a workspace
  opens, when the window regains focus, when the app resumes, and after a git
  pull or branch switch.

The file is created lazily, on the first Save that turns something on: a
default theme, a catalog output, or a version-history choice. Saving only
defaults never creates it (so no `.docblocks/` folder appears), and opening a
folder never writes it. Once the file exists it is updated in place, even back
to defaults, and never deleted. Single files and `.dbk` bundles opened on their
own have no folder, so they have no workspace settings.

## The file

```json
{
  "version": 1,
  "documents": { "defaultTheme": "warm-earth" },
  "versionHistory": { "enabled": true, "keep": 50 },
  "catalog": {
    "title": "Articles",
    "sort": "date",
    "exclude": ["drafts"],
    "html": { "enabled": true, "path": "index.html", "theme": "warm-earth" },
    "json": { "enabled": true, "path": "catalog.json", "content": "metadata" }
  }
}
```

Every section and field except `version` is optional. An absent field means
"inherit" (version history) or "off" (catalog outputs).

| Field                    | Meaning                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `documents.defaultTheme` | Theme for documents whose frontmatter names none (`squisq-theme`, or the legacy `themeId` / `theme`).                              |
| `versionHistory.enabled` | `true` / `false` overrides the app-wide version-history preference for this folder.                                                |
| `versionHistory.keep`    | Revisions kept per document (1–1000; default 50).                                                                                  |
| `catalog.title`          | Catalog heading (default `Documents`).                                                                                             |
| `catalog.sort`           | `title` (default), `date` (frontmatter `date`, newest first), or `path`.                                                           |
| `catalog.exclude`        | Folder or file paths left out of the catalog. `node_modules`, dot-folders, `_files` companions, and `_squisq` are always left out. |
| `catalog.html.enabled`   | Keep a catalog page up to date.                                                                                                    |
| `catalog.html.path`      | Catalog page path (default `index.html`); must end in `.html` or `.htm`.                                                           |
| `catalog.html.theme`     | Theme for the catalog page only (default: `documents.defaultTheme`).                                                               |
| `catalog.json.enabled`   | Keep catalog data up to date.                                                                                                      |
| `catalog.json.path`      | Catalog data path (default `catalog.json`); must end in `.json`.                                                                   |
| `catalog.json.content`   | `metadata` (default) or `markdown` to include each document's Markdown source.                                                     |

The file is validated exactly. An unknown field makes it **invalid**, and a
`version` newer than this DocBlocks understands makes it **unsupported**. In
both cases DocBlocks applies none of it, never rewrites it, and shows why in
the settings dialog. Output paths may not be in hidden folders, `_files`
companions, `_squisq`, or `node_modules`, and theme ids are plain slugs; an id
DocBlocks does not know renders as the standard theme.

Saves are field-level patches over the version of the file DocBlocks last
read. If another window, a sync client, or a git pull changed it in between,
the patch is applied to the newer file instead of overwriting it.

## Precedence

| Setting                | Order                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------- |
| Document theme         | document frontmatter → `documents.defaultTheme` → standard                              |
| Export dialog theme    | document frontmatter → workspace default → last-used export theme → standard            |
| Version history on/off | `versionHistory.enabled` → an older browser-local per-workspace choice → app preference |
| Revisions kept         | `versionHistory.keep` → host default → 50                                               |

The workspace theme is a fallback: a document's own theme always wins.
Rendered outside-in pages (HTML, DOCX, PDF, …) pick up a changed default the
next time each is saved. The editor's live preview follows the workspace
theme once DocBlocks pins a Squisq release whose `EditorShell` accepts
`defaultThemeId`.

Before workspace settings existed, the per-workspace version-history choice
was stored in the browser. It is still honored, and the first Save of
workspace settings moves it into the file.

## Catalog outputs

With either catalog output enabled, DocBlocks walks the workspace and lists
every Markdown document and every rendered outside-in document (HTML, DOCX,
PDF, PPTX, XLSX, CSV). An outside-in document is described from its Markdown
companion; an HTML page that was never imported is read directly; other
formats without a companion are listed by name.

Each entry carries the document's path, its companion `source` when there is
one, its format, title (frontmatter `title`, else its shallowest heading, else
the file name), frontmatter `description` / `author` / `date` / `tags` /
theme, a heading outline, a word count, and a short excerpt:

```json
{
  "generator": "docblocks-workspace-catalog",
  "version": 1,
  "title": "Articles",
  "documents": [
    {
      "path": "battle-of-britain.html",
      "source": "battle-of-britain_files/battle-of-britain.md",
      "format": "html",
      "title": "The Battle of Britain",
      "date": "2026-09-15",
      "outline": [{ "level": 1, "title": "The Battle of Britain" }],
      "wordCount": 1840,
      "excerpt": "In the summer of 1940…"
    }
  ]
}
```

The catalog page is the same list rendered as a themed, script-free HTML page,
grouped by folder, with links relative to the page itself. Outside-in
documents link to their rendered file.

Outputs refresh a couple of seconds after edits settle (and at least every 20
seconds during a long editing session), after file-tree changes, after a git
pull or branch switch, and when a workspace opens. They are designed to be
safe in shared and versioned folders:

- **Never clobbering.** DocBlocks replaces a file only when it carries the
  catalog marker it writes (the leading `"generator"` key, or an HTML comment
  right after the doctype). A hand-written `index.html` at the configured path
  is left alone, and the settings dialog explains why the catalog is blocked.
- **Deterministic.** There are no timestamps or file-system dates, and ordering
  never depends on locale, so identical documents produce byte-identical
  output on every surface and machine. A file is written only when its bytes
  change; the page also records a digest of its inputs, so a different
  DocBlocks or Squisq version does not rewrite it for styling alone.
- **Bounded.** A workspace with more than 5,000 documents, 20,000 folders,
  folders nested over 32 deep, or more than 256 MiB of documents writes no
  catalog rather than a truncated one. Documents over 4 MiB are listed by
  name.
- **Read-only when opened.** Opening a generated catalog shows it read-only.
  The page is never imported as an outside-in document.

In git repositories, consider marking outputs as generated so reviews skip
them:

```text
# .gitattributes
index.html linguist-generated
catalog.json linguist-generated
```

### Where catalogs update

| Surface               | Trigger                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Site, desktop, mobile | Saves and file-tree changes in DocBlocks, git pull/branch switch, workspace open.                                                                      |
| VS Code               | Any save in VS Code and file-watcher events for documents, in trusted and writable folders. **DocBlocks: Update Workspace Catalogs** forces a refresh. |
| CLI                   | `docblocks workspace refresh [dir]` (see [`docs/cli.md`](cli.md)); `build` and `serve` honor `documents.defaultTheme`.                                 |

## For contributors

`packages/core/src/workspace-settings/` is the single implementation every
surface shares — the exact-shape parser and serializer (`settings.ts`), the
JSON Schema (`schema.ts`), patch merging (`store.ts`), the catalog model
(`catalog.ts`), the walker and marker-guarded writer (`outputs.ts`), and the
debounced single-flight scheduler (`scheduler.ts`). Surfaces supply a
filesystem adapter and a renderer only. Adding a setting means extending the
v1 shape, its parser, patch handling, serializer key order, and JSON Schema
together (tests assert they agree), then the shared
`WorkspaceSettingsControls`.
