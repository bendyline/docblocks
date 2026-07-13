# @bendyline/docblocks-cli

The DocBlocks command-line surface for document build and preview, linked-Squisq
format conversion, MP4 rendering, document parsing, and a local MCP server for
agents.

## Installation

Node.js 22.14 or newer is required.

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
| `docblocks init [dir]`             | Create minimal `.docblocks/config.json` metadata.     |
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

# Discover authoring vocabulary from linked Squisq
docblocks themes
docblocks transforms

# Start MCP with no filesystem authority
docblocks mcp

# Grant independent roots when an agent needs files or durable output
docblocks mcp --allow-read ./documents --allow-write ./exports
```

`convert` and `video` accept Markdown, Squisq JSON Doc, DBK/ZIP, folders, and
import-capable linked-registry formats. Direct `build`, `convert`, and `video`
outputs replace existing destination files. MCP conversions instead return
immutable session artifacts; only explicit `save_artifact` materializes one, using
no-replace or hash-conditional replacement semantics.

The live linked registry currently covers Markdown, DOCX, PDF, PPTX, XLSX, CSV,
HTML, HTML ZIP, EPUB, DBK, MP4, and GIF. Direction varies by format, so use the
CLI reference or MCP `list_formats` rather than assuming every format imports.

MP4/GIF rendering requires Chromium and FFmpeg. Install Chromium with
`npx playwright install chromium`; Squisq resolves FFmpeg from `SQUISQ_FFMPEG`,
`PATH`, or `ffmpeg-static`, in that order.

## Development with linked Squisq

From the DocBlocks repository root:

```bash
npm run link:squisq
npm run check:squisq-linked
npm run test:mcp:linked
npm run all
```

The linked assurance commands use the sibling `..\squisq` source checkout, not the
npm package copy.
