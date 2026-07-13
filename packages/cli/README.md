# @bendyline/docblocks-cli

DocBlocks CLI — build, serve, convert, and manage markdown document projects from the command line.

## Installation

```bash
npm install -g @bendyline/docblocks-cli
```

## Commands

### `docblocks init [dir]`

Initialize a new DocBlocks workspace. Creates a `.docblocks` directory with configuration.

### `docblocks build`

Build markdown files into HTML output.

```bash
docblocks build -i ./docs -o ./dist
```

**Options:**

- `-i, --input <dir>` — Input directory (default: `.`)
- `-o, --output <dir>` — Output directory (default: `dist`)
- `-t, --theme <id>` — Visual theme to apply

### `docblocks serve`

Start a local development server for previewing documents.

**Options:**

- `-p, --port <port>` — Port to listen on (default: `3000`)
- `-d, --dir <dir>` — Directory to serve (default: `.`)
- `-t, --theme <id>` — Visual theme to apply
- `--host <host>` — Interface to bind (default: `127.0.0.1`)
- `--allow-network` — Required before binding a non-loopback host

The preview server resolves the served root and every requested file physically,
rejects symlink/junction escapes, limits request concurrency and file size, and
never returns native error details to HTTP clients. It serves only Markdown and
explicit browser-preview asset types; hidden paths, credentials, private-key
formats, and arbitrary repository files are not exposed.

### `docblocks convert <input>`

Convert any document accepted by the linked Squisq CLI registry. With no
`--formats` option, DocBlocks preserves its historical DOCX, PPTX, PDF, HTML,
and DBK output set; explicitly requested output may use any export-capable
registry format. `<input>` can be a supported document, a `.zip`/`.dbk`
container, or a folder.

```bash
# Convert to all formats
docblocks convert story.md

# Convert to specific formats with a theme
docblocks convert story.md -f docx,pdf -t cinematic

# Apply a transform style before exporting
docblocks convert story.md --transform documentary -o ./output
```

**Options:**

- `-o, --output-dir <dir>` — Output directory
- `-f, --formats <list>` — Comma-separated linked-registry formats. Current
  exports: md, docx, pdf, pptx, xlsx, csv, html, htmlzip, epub, dbk, mp4, gif
- `-t, --theme <id>` — Visual theme (use `docblocks themes` to list)
- `--transform <style>` — Transform style (use `docblocks transforms` to list)

### `docblocks video <input> [output]`

Render a document to MP4 video with synced animations. Requires ffmpeg and Playwright. `<input>` can be a `.md` file, a `.zip`/`.dbk` container, or a folder.

```bash
docblocks video story.md --quality high --orientation portrait
```

**Options:**

- `-o, --output <path>` — Output MP4 path
- `--fps <number>` — Frames per second (1-120, default: 30)
- `--quality <level>` — draft, normal, or high
- `--orientation <orient>` — landscape or portrait
- `--captions <style>` — off, standard, or social
- `--width <pixels>` / `--height <pixels>` — Override dimensions

### `docblocks mcp`

Start a local MCP (Model Context Protocol) server over stdio for agentic document
creation, inspection, validation, conversion, and comparison.

```bash
docblocks mcp
docblocks mcp --allow-read ./documents --allow-write ./exports
```

MCP starts with no filesystem authority. Inline Markdown and temporary
artifacts still work, while file reads and durable writes require explicit
startup grants. Every configurable resource budget has a non-bypassable
server ceiling:

| Budget                       |      Default |  Hard ceiling |
| ---------------------------- | -----------: | ------------: |
| Read roots / write roots     |        0 / 0 |       64 each |
| `--max-concurrency`          |            2 |            32 |
| `--operation-timeout-ms`     |   120,000 ms |  1,800,000 ms |
| `--max-input-bytes`          |      100 MiB |         1 GiB |
| `--max-artifact-bytes`       |      500 MiB |       500 MiB |
| `--max-artifact-total-bytes` |        1 GiB |         4 GiB |
| `--max-artifacts`            |           64 |         1,024 |
| `--artifact-ttl-ms`          | 1,800,000 ms | 86,400,000 ms |
| `--max-resource-bytes`       |       25 MiB |       100 MiB |
| `--max-report-bytes`         |        8 MiB |        32 MiB |
| `--max-report-total-bytes`   |       64 MiB |       256 MiB |

The CLI operation timeout must be at least 1,000 ms. Other numeric budget
options must be positive integers. Aggregate artifact and report limits must
be at least their corresponding per-item limits.

#### Artifact-first workflow

`convert_document`, `create_document_bundle`, and `preview_document` return
immutable `ArtifactRef` objects and MCP resource links. They do not write to a
user-selected path. An artifact records its format, MIME type, byte size,
SHA-256, source hash, applied options, content-derived `+runtime.<hash>` engine
versions, and expiry time, so an agent can reason about provenance without
loading binary data into its context.

The usual workflow is:

1. Call `list_roots` if the source or final destination is a local file.
2. Inspect and validate the document before conversion.
3. Call `convert_document` with up to 12 distinct targets. All targets share
   one normalized source.
4. Use `preview_document` for paginated image checks and inspect its
   `previewBasis`. Markdown/DBK report `source-render`; imported Office/PDF and
   other document artifacts report `reconstructed-import` because they render
   the normalized import rather than native-application pixels. MP4 and GIF
   file and artifact sources report `native-extracted` and produce one bounded
   first-frame JPEG.
5. Reuse the returned artifact as another tool's source, read a bounded result
   through `docblocks://artifacts/{id}`, or call `save_artifact` for durable
   output.

Artifacts are scoped to one server process. Current defaults retain at most 64
artifacts, 500 MiB per artifact, and 1 GiB in total for 30 minutes. Resource
reads are capped at 25 MiB; use `save_artifact` for a larger result. Closing
the server removes its temporary artifact store. A result publishes at most
500 diagnostic entries; additional entries are aggregated by severity while
preserving occurrence counts so worst-case reports remain within the 8 MiB
default per-report budget.

Example conversion arguments:

```json
{
  "source": {
    "kind": "markdown",
    "markdown": "# Quarterly review\n\n## Revenue\n\nRevenue grew 18%.",
    "name": "quarterly-review.md"
  },
  "targets": [{ "format": "pptx", "fidelity": "editable-native" }, { "format": "pdf" }],
  "themeId": "documentary",
  "autoTemplates": true,
  "title": "Quarterly review"
}
```

Materialization is no-replace by default:

```json
{
  "artifactUri": "docblocks://artifacts/00000000-0000-4000-8000-000000000000",
  "destination": {
    "rootId": "root-0123456789abcdef",
    "path": "reports/quarterly-review.pptx",
    "ifExists": "error",
    "expectedSha256": null
  }
}
```

Replacement requires `ifExists: "replace"` and the SHA-256 of the existing
destination. DocBlocks serializes replacement attempts in the server process,
streams the bounded hash, and revalidates it after staging immediately before
atomic publication. Filesystems do not expose one portable storage-atomic CAS
primitive to Node, so an unrelated external writer can still race that final
publish boundary; use no-replace mode when external writers are not coordinated.

#### Sources and filesystem roots

Agent-native tools accept one exact source shape:

- `{"kind":"markdown","markdown":"...","name":null}` — bounded inline
  Markdown; no filesystem grant required.
- `{"kind":"file","rootId":"...","path":"report.docx","format":null}` —
  a file below a read-enabled root returned by `list_roots`.
- `{"kind":"artifact","uri":"docblocks://artifacts/..."}` — an artifact
  created by this server process.
- `{"kind":"bundle","markdown":"...","assets":[...],"name":null}` —
  Markdown plus up to 256 file- or artifact-backed assets. Use
  `create_document_bundle` to preserve it as DBK.

Root IDs are opaque aliases, not authority. Paths are canonical,
root-relative, forward-slash paths; absolute paths, drive prefixes,
backslashes, `.`/`..`, empty segments, and physical symlink escapes are
rejected. An `--allow-write` grant does not imply read access, and an
`--allow-read` grant does not imply write access.

A loose Markdown file never gains implicit access to sibling media. Use an
explicit bundle source or an existing DBK/ZIP container when media must travel
with the document.

#### Agent-native tools

- `list_roots` — List read/write root aliases granted at startup.
- `list_formats` / `list_themes` / `list_transform_styles` — Discover the
  exact linked Squisq conversion and authoring vocabulary.
- `get_conversion_report` — Retrieve persisted diagnostics and provenance for
  an artifact created by this server process.
- `convert_document` — Convert any importable linked-registry source into one
  or more immutable artifacts.
- `create_document_bundle` — Package Markdown, media, alt text, credit, and
  license metadata into a DBK artifact.
- `save_artifact` — Materialize an artifact with no-replace or conditional
  replacement semantics.
- `inspect_document` — Return bounded metadata, statistics, outline, block
  provenance, assets, theme information, and diagnostics.
- `validate_document` — Validate structure, templates, annotations, assets,
  accessibility metadata, and optional target-format fidelity.
- `compare_documents` — Compare semantic text, structure, tables, media,
  themes, layouts, metadata, timing, and accessibility retention.
- `preview_document` — Render bounded, paginated previews as immutable image
  artifacts (up to 20 items per call). The exact `previewBasis` distinguishes a
  Squisq source render, a reconstructed document import, and a natively
  extracted MP4/GIF frame; reconstructed imports are not native-application
  pixel verification.
- `list_templates` / `describe_template` — Discover exact Squisq authoring
  annotations and inputs.
- `recommend_templates` — Profile bounded document blocks with the linked
  Squisq recommender and return content-compatible template candidates.
- `describe_theme` / `infer_theme_from_file` / `inspect_pptx_layouts` — Inspect
  built-in themes or infer reusable theme/layout information from Office files.
- `apply_inferred_theme` — Infer an Office theme and optional layouts, apply
  them to a document, and return a reusable themed DBK artifact.

Conversion, preview, and diagnostic results use versioned, exact
structured-output schemas. `convert_document` and `preview_document` emit MCP
progress notifications and observe cancellation at bounded work boundaries.
When capacity is exhausted, the exact `busy` error includes
`operationLoad: { active, capacity }` so an agent can back off without
guessing. Server shutdown stops admission, cancels active operations with a
stable reason, performs a bounded cleanup drain, and still disposes artifacts
if a non-cooperative operation makes that drain time out.

#### Formats and fidelity

The MCP capability manifest is kept aligned with the linked Squisq CLI
registry:

| Format   | Import | Export |
| -------- | :----: | :----: |
| Markdown |   ✓    |   ✓    |
| DOCX     |   ✓    |   ✓    |
| PDF      |   ✓    |   ✓    |
| PPTX     |   ✓    |   ✓    |
| XLSX     |   ✓    |   ✓    |
| CSV      |   ✓    |   ✓    |
| HTML     |   ✓    |   ✓    |
| HTML ZIP |   —    |   ✓    |
| EPUB     |   —    |   ✓    |
| DBK/ZIP  |   ✓    |   ✓    |
| MP4      |   —    |   ✓    |
| GIF      |   —    |   ✓    |

DOCX and PPTX default to `editable-native`; MP4 and GIF default to
`rendered-fidelity`; other targets default to `semantic`. Fidelity values are
target-checked rather than descriptive labels:

- `semantic` is accepted for document and interchange targets, not rendered
  MP4/GIF media.
- `editable-native` is accepted for DOCX, PPTX, XLSX, and the native DBK
  container.
- `rendered-fidelity` describes the implemented PPTX/PDF visual-capture paths
  and the linked MP4/GIF frame renderers; `hybrid` is accepted for PPTX/PDF.

Unsupported target/fidelity combinations are rejected before conversion.
Rendered PPTX/PDF applies `themeId`, `transformId`, `autoTemplates`, and
`title` through the linked Squisq normalization pipeline before capture while
retaining container media and document-defined themes. `rendered-fidelity`
packages the actual linked-Squisq player pixels; `hybrid` adds bounded semantic
text retention (plus the transformed Markdown source attachment for PDF).
Image-backed PPTX output favors visual fidelity over native shape editing, and
hybrid PDF is not a substitute for a fully tagged accessible PDF. MP4 and GIF
require the rendering dependencies used by the video command; GIF cannot
retain audio. MCP rejects MP4/GIF requests before launching a browser when
duration, FPS, dimensions, frame count, or aggregate frame-pixels exceed the
bounded in-memory capture budget.

#### Discovery, resources, and prompts

The MCP intentionally exposes one artifact-first API rather than maintaining
format-specific or path-writing aliases. Use `list_formats`, `list_themes`,
`list_transform_styles`, and the template/theme inspection tools to discover
the linked authoring vocabulary. Reverse conversion is the same
`convert_document` workflow with a DOCX/PPTX/PDF source and a Markdown or DBK
target; transformation is selected with `transformId` on that same call.

The server exposes `docblocks://formats`, `docblocks://authoring-guide`, the
bounded `docblocks://artifacts/{id}` resource template, and the matching
`docblocks://reports/{id}` conversion-report template. `get_conversion_report`
returns the same persisted provenance and diagnostics as structured content.
Guided `create-presentation`, `create-video`, and `create-document` prompts are
also available and use only current artifact-first tool names.

#### Current transport boundary

`docblocks mcp` is currently a local stdio server. It does not expose
Streamable HTTP, OAuth, remote download URLs, durable/resumable MCP tasks, or
cross-process artifact storage. Artifact URIs are not bearer URLs and cannot
be resolved by another server instance. If a remote transport is added, it
must add authenticated principal isolation, per-principal quotas, Origin
validation, and durable cancellation before these local assumptions can be
relaxed.

**Claude Desktop / Copilot integration:**

```json
{
  "mcpServers": {
    "docblocks": {
      "command": "npx",
      "args": ["-y", "@bendyline/docblocks-cli", "mcp", "--allow-write", "/path/to/exports"]
    }
  }
}
```

#### Linked-Squisq assurance for contributors

The canonical linked assurance compares MCP behavior to the sibling checkout,
never an npm registry snapshot:

```bash
npm run test:mcp:linked
```

That gate rebuilds the sibling source, links all `@bendyline/squisq*` packages,
then verifies physical realpaths, source-versus-dist freshness, the linked
commit and dirty-tree fingerprint, registry capabilities, and exact parity
between the MCP target schema and `createCliRegistry().list()`. It then runs the
focused upstream format/media contracts, linked DocBlocks registry and
cancellation contracts, and the complete MCP suite. `npm install` can replace
the links; rerun the linked gate after dependency installation. The
repository-wide `npm run all` gate remains the release assurance check for the
complete DocBlocks workspace.

### `docblocks themes`

List all available visual themes.

### `docblocks transforms`

List all available transform styles.

### `docblocks parse <input>`

Parse a markdown file and print its structure as JSON.

## License

MIT
