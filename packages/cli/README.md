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
docblocks mcp
```

**MCP Tools exposed:**

- `export_markdown_to_docx` / `_pdf` / `_pptx` / `_html` / `_video` — Export markdown to polished output formats
- `analyze_markdown` — Extract content structure (stats, quotes, facts, dates)
- `restyle_markdown` — Apply a transform style and return restyled markdown
- `list_themes` / `list_transform_styles` / `list_export_formats` — Discovery tools

All export tools accept raw markdown text directly — AI agents can write content and immediately export without temp files.

**Claude Desktop / Copilot integration:**

```json
{
  "mcpServers": {
    "docblocks": { "command": "npx", "args": ["docblocks", "mcp"] }
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
