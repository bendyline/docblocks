# @bendyline/docblocks-cli

The DocBlocks command-line surface for document build and preview, linked-Squisq
format conversion, MP4 rendering, document parsing, and a local MCP server for
agents.

[CLI and MCP overview](https://docblocks.com/cli/)

## Installation

Node.js 22.22.2+, 24.15.0+, or 26+ is required.

```bash
npm install -g @bendyline/docblocks-cli
docblocks --help
```

## Documentation

- [Authoritative CLI reference](https://github.com/bendyline/docblocks/blob/main/docs/cli.md)
- [MCP architecture and protocol guide](https://github.com/bendyline/docblocks/blob/main/docs/mcp.md)

Those guides describe current input support, linked Squisq ownership, format
directions, overwrite behavior, MCP authority, artifact lifecycle, and assurance.

## Commands

| Command                            | Purpose                                               |
| ---------------------------------- | ----------------------------------------------------- |
| `docblocks build`                  | Recursively build Markdown into standalone HTML.      |
| `docblocks serve`                  | Run a constrained local preview server.               |
| `docblocks convert <input>`        | Convert through the linked Squisq registry.           |
| `docblocks video <input> [output]` | Render a configurable MP4.                            |
| `docblocks mcp`                    | Start the artifact-first MCP server over local stdio. |
| `docblocks themes`                 | List linked Squisq theme IDs.                         |
| `docblocks transforms`             | List linked Squisq transform IDs.                     |
| `docblocks parse <input>`          | Parse UTF-8 Markdown into Squisq Markdown AST JSON.   |

Use `docblocks help <command>` for the installed option summary.

## Examples

```bash
# Build and preview Markdown
docblocks build --input ./docs --output ./dist
docblocks serve --dir ./docs

# The no-flag conversion set is exactly DOCX, PPTX, PDF, HTML, and DBK
docblocks convert story.md

# Select any export-capable linked-registry formats
docblocks convert report.docx --formats md,pdf,pptx --output-dir ./exports

# Render MP4 with explicit media controls
docblocks video story.md --quality high --orientation portrait

# Render the Dashboard rendition to a square image with accent cards
docblocks convert report.md --formats png --image-resolution square --image-style accent

# Discover authoring vocabulary from linked Squisq
docblocks themes
docblocks transforms

# Start MCP with no filesystem authority
docblocks mcp

# Grant independent roots when an agent needs files or durable output
docblocks mcp --allow-read ./documents --allow-write ./exports
```

For durable output, call `list_roots` before drafting. If no root is write-enabled,
restart the server with `--allow-write`; do not bypass MCP with the direct `convert`
command. Plain text or ordinary Markdown can be passed directly to
`convert_document` without a preflight; compatible templates are chosen automatically,
and explicit Squisq annotations remain optional overrides. For PPTX, a level-one
heading creates each deliberate slide boundary by itself; do not add `---` between
slide headings unless a visible horizontal rule is intended. `get_authoring_context`
is optional discovery for exact annotation examples, safe defaults, and semantically
described theme/Summarize choices. MCP guidance tells agents to infer and choose a
style from the brief rather than presenting raw IDs, asking one compact high-level
question only when the choice is materially ambiguous. The complete catalog remains
available at `docblocks://authoring-guide`.

`convert` and `video` accept Markdown, Squisq JSON Doc, DBK/ZIP, folders, and
import-capable linked-registry formats. `build`/`serve` standalone HTML includes
Copy controls for ordinary fenced code blocks; Mermaid fences remain diagrams. `build` replaces generated HTML files;
`convert` and `video` refuse existing destinations unless `--allow-overwrite` is
passed. Multi-target conversion stages the complete batch and rolls back replacements
if publication fails. Build traversal, input bytes, and output bytes are bounded, as
are parse input and JSON output. MCP conversions instead return
immutable session artifacts; only explicit `save_artifact` materializes one, using
no-replace or hash-conditional replacement semantics.

The package root is a side-effect-free programmatic API for `runBuild`, `runConvert`,
`runVideo`, and `runParse`. Importing it never starts Commander; the executable is
the separate `docblocks` bin entry.

The live linked registry currently covers Markdown, DOCX, PDF, PPTX, XLSX, CSV,
HTML, HTML ZIP, EPUB, DBK, MP4, GIF, and PNG. Direction varies by format, so use
the CLI reference or MCP `list_formats` rather than assuming every format imports.

MP4/GIF rendering requires Chromium and FFmpeg. Install Chromium with
`npx playwright install chromium`; Squisq resolves FFmpeg from `SQUISQ_FFMPEG`,
`PATH`, or `ffmpeg-static`, in that order. PNG renders the document's Dashboard
rendition to a single image and needs Chromium only.
