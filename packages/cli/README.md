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

Convert a markdown document to DOCX, PPTX, PDF, HTML, or DBK container format. `<input>` can be a `.md` file, a `.zip`/`.dbk` container, or a folder.

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
- `-f, --formats <list>` — Comma-separated formats: docx, pptx, pdf, html, dbk
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

Start an MCP (Model Context Protocol) server over stdio for AI-assisted document operations.

```bash
docblocks mcp --allow-write ./exports
# Add file-backed inputs only when needed:
docblocks mcp --allow-read ./documents --allow-write ./exports
```

MCP starts without filesystem authority by default. Raw Markdown remains
available through `source: { "kind": "text", "text": "..." }` (or the
deprecated `markdown` field). File sources use the explicit
`source: { "kind": "file", "path": "..." }` form and must be physically
contained by an `--allow-read` root. Every output must be contained by an
`--allow-write` root. File payloads, generated output, recursive work, child
processes, and concurrent expensive tools are bounded; use `--max-concurrency`
to change the default of 2 (maximum 32).

For file-backed Markdown with relative media, package the document and media
as a `.dbk`/`.zip` container before exporting. A loose `.md` source does not
implicitly grant or embed sibling files.

**MCP Tools exposed:**

- `export_markdown_to_docx` / `_pdf` / `_pptx` / `_html` / `_video` — Export markdown to polished output formats
- `convert_docx_to_markdown` / `convert_pptx_to_markdown` / `convert_pdf_to_markdown` — Import professional document formats as Markdown
- `analyze_markdown` — Extract content structure (stats, quotes, facts, dates)
- `restyle_markdown` — Apply a transform style and return restyled markdown
- `list_themes` / `list_transform_styles` / `list_export_formats` — Discovery tools

The server also exposes the `docblocks://formats` resource and guided
`create-presentation`, `create-video`, and `create-document` prompts.

All export tools accept raw markdown text directly — AI agents can write content and immediately export without temp files.

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

### `docblocks themes`

List all available visual themes.

### `docblocks transforms`

List all available transform styles.

### `docblocks parse <input>`

Parse a markdown file and print its structure as JSON.

## License

MIT
