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
default theme, a page template, a site address, a catalog output, or a
version-history choice. Saving only
defaults never creates it (so no `.docblocks/` folder appears), and opening a
folder never writes it. Once the file exists it is updated in place, even back
to defaults, and never deleted. Single files and `.dbk` bundles opened on their
own have no folder, so they have no workspace settings.

## The file

```json
{
  "version": 1,
  "documents": {
    "defaultTheme": "warm-earth",
    "outputTemplates": { "html": "_templates/post.html" },
    "siteUrl": "https://example.com/articles/"
  },
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

| Field                            | Meaning                                                                                                                                                                                                                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `documents.defaultTheme`         | Theme for documents whose frontmatter names none (`squisq-theme`, or the legacy `themeId` / `theme`).                                                                                                                                                                              |
| `documents.outputTemplates.html` | [Page template](outside-in.md#page-templates) for static Web pages whose companion names none (`squisq-output-template`); a workspace-relative `.html` or `.htm` path.                                                                                                             |
| `documents.siteUrl`              | The `http` or `https` address the workspace root is published at, such as `https://example.com/articles/`. Templated Web pages use it to give their [social preview picture](outside-in.md#page-templates) an absolute URL. No query or fragment.                                  |
| `versionHistory.enabled`         | `true` / `false` overrides the app-wide version-history preference for this folder.                                                                                                                                                                                                |
| `versionHistory.keep`            | Revisions kept per document (1–1000; default 50).                                                                                                                                                                                                                                  |
| `catalog.title`                  | Catalog heading (default `Documents`).                                                                                                                                                                                                                                             |
| `catalog.sort`                   | `title` (default), `date` (frontmatter `date`, newest first), or `path`.                                                                                                                                                                                                           |
| `catalog.exclude`                | Folder or file paths left out of the catalog. Dot-folders, `node_modules` (also `bower_components` and `__pycache__`), `_files` companions, and `_squisq` folders are always left out, at any depth. Documents are `.md`, `.markdown`, and `.mdown` files plus outside-in exports. |
| `catalog.html.enabled`           | Keep a catalog page up to date.                                                                                                                                                                                                                                                    |
| `catalog.html.path`              | Catalog page path (default `index.html`); must end in `.html` or `.htm`.                                                                                                                                                                                                           |
| `catalog.html.theme`             | Theme for the catalog page only (default: `documents.defaultTheme`).                                                                                                                                                                                                               |
| `catalog.json.enabled`           | Keep catalog data up to date.                                                                                                                                                                                                                                                      |
| `catalog.json.path`              | Catalog data path (default `catalog.json`); must end in `.json`.                                                                                                                                                                                                                   |
| `catalog.json.content`           | `metadata` (default) or `markdown` to include each document's Markdown source.                                                                                                                                                                                                     |

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

| Setting                | Order                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| Document theme         | document frontmatter → `documents.defaultTheme` → standard                                                      |
| Web page template      | companion `squisq-output-template` (`none` opts out) → `documents.outputTemplates.html` → DocBlocks' plain page |
| Export dialog theme    | the theme the editor previews: document frontmatter → workspace default → standard                              |
| Version history on/off | `versionHistory.enabled` → an older browser-local per-workspace choice → app preference                         |
| Revisions kept         | `versionHistory.keep` → host default → 50                                                                       |

The workspace theme is a fallback: a document's own theme always wins.
Rendered outside-in pages (HTML, DOCX, PDF, …) pick up a changed default the
next time each is saved. The editor's live preview follows it too, and its
Theme picker lists it as **Workspace default**; the export dialog starts on
whatever theme the preview shows.

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
theme, first-published and last-modified dates, a heading outline, a word
count, a short excerpt, and a content hash:

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
      "firstPublishedDate": "2026-09-15T17:42:05Z",
      "lastModifiedDate": "2026-10-02T08:10:51Z",
      "outline": [{ "level": 1, "title": "The Battle of Britain" }],
      "wordCount": 1840,
      "excerpt": "In the summer of 1940…",
      "contentHash": "3f0c…"
    }
  ]
}
```

`firstPublishedDate` is when the document first appeared in the catalog JSON;
`lastModifiedDate` is when the catalog last picked up a change to its content.
Both are UTC ISO 8601 timestamps. They are kept from one catalog JSON to the
next by path. A document gets the current time when it is new to the catalog
(including after a rename, or after it was removed and added back) and a new
`lastModifiedDate` when its `contentHash` changes. `contentHash` is the
SHA-256 of the document's source (its Markdown companion for outside-in
documents) with line endings normalized. Re-rendering an outside-in page
without editing its Markdown, or checking it out with CRLF line endings, does
not count as a change. A document listed by name only has no
hash and keeps its first dates. Only the JSON carries these fields. Deleting
the catalog JSON or moving its path starts the history over. To backfill
history, edit the dates in the file: DocBlocks keeps any valid ISO 8601 date
or timestamp it finds there.

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
- **Deterministic.** There are no file-system dates, a document's catalog
  dates come from the previous catalog JSON and change only with its content,
  and
  ordering never depends on locale, so identical documents (and an identical
  previous catalog) produce byte-identical output on every surface and
  machine. A file is written only when its bytes
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
