# DocBlocks CLI reference

This is the authoritative guide to the current `docblocks` command-line surface.
It documents the behavior shipped from `packages/cli`, including the capabilities
delegated to the linked Squisq checkout. The separate [MCP architecture
guide](mcp.md) is authoritative for the protocol started by `docblocks mcp`.

The executable requires Node.js 22.14 or newer and is published as
`@bendyline/docblocks-cli`:

```bash
npm install -g @bendyline/docblocks-cli
docblocks --help
```

The package is a command surface, not a supported JavaScript library API. Functions
such as `runBuild`, `runConvert`, and `startPreviewServer` are contributor-facing
implementation seams unless they are explicitly exported in a future package
contract.

## Command catalog

<!-- BEGIN CLI COMMAND CATALOG -->

| Command      | Purpose                                                       |
| ------------ | ------------------------------------------------------------- |
| `build`      | Recursively build Markdown files into standalone HTML.        |
| `serve`      | Preview a directory through a constrained local HTTP server.  |
| `convert`    | Convert a linked-Squisq input into one or more files.         |
| `video`      | Render a linked-Squisq input to a configurable MP4.           |
| `mcp`        | Start the local artifact-first MCP server over stdio.         |
| `themes`     | List theme IDs from the linked Squisq registry.               |
| `transforms` | List transform-style IDs from the linked Squisq registry.     |
| `parse`      | Parse UTF-8 Markdown content into Squisq's Markdown AST JSON. |

<!-- END CLI COMMAND CATALOG -->

Commander also supplies `-h, --help`, `help [command]`, and `-V, --version`.
Use `docblocks help <command>` for the installed binary's option summary.

## Output and filesystem semantics

Direct CLI commands run with the normal authority of the invoking process. They do
not inherit the MCP server's root grants, quotas, conditional-write policy, or
operation timeout.

| Command   | Existing destination                                                                                                   |
| --------- | ---------------------------------------------------------------------------------------------------------------------- |
| `build`   | Replaces generated HTML files.                                                                                         |
| `convert` | Refuses the run when any converter-named destination exists; `--allow-overwrite` atomically replaces them.             |
| `video`   | Refuses the run when the selected MP4 exists; `--allow-overwrite` replaces it through FFmpeg.                          |
| `mcp`     | Creates temporary artifacts first; durable writes happen only through the explicitly conditional `save_artifact` tool. |

Normal progress and human-readable status go to stderr. Commands intended for
machine discovery keep their values or JSON on stdout. The MCP command reserves
stdout for protocol messages.

## `docblocks build`

```bash
docblocks build --input ./docs --output ./dist --theme documentary
```

| Option               | Default | Meaning                                                    |
| -------------------- | ------- | ---------------------------------------------------------- |
| `-i, --input <dir>`  | `.`     | Source directory.                                          |
| `-o, --output <dir>` | `dist`  | Generated HTML directory.                                  |
| `-t, --theme <id>`   | unset   | Override the document theme; otherwise Squisq resolves it. |

The command recursively finds `.md` and `.markdown` files, sorts them, preserves
their relative directory structure, and replaces each extension with `.html`. It
fails when the input is not a directory or contains no Markdown files. Traversal
is sequential and stops after 100,000 filesystem entries or 64 directory levels;
permission and I/O failures remain errors rather than being reported as absence.

The render path is shared with `serve`: DocBlocks asks Squisq to parse Markdown,
project it into the Squisq document model, and export HTML, then embeds Squisq's
standalone player bundle. Referenced local images are embedded only after physical
containment checks. The default image budget is 100 images, 20 MiB per image, and
50 MiB in aggregate.

## `docblocks serve`

```bash
docblocks serve --dir ./docs --port 3000
```

| Option              | Default     | Meaning                                                    |
| ------------------- | ----------- | ---------------------------------------------------------- |
| `-p, --port <port>` | `3000`      | Listening port; `0` asks the OS for an ephemeral port.     |
| `-d, --dir <dir>`   | `.`         | Directory to preview.                                      |
| `-t, --theme <id>`  | unset       | Override the document theme; otherwise Squisq resolves it. |
| `--host <host>`     | `127.0.0.1` | Interface to bind.                                         |
| `--allow-network`   | off         | Required for a non-loopback host.                          |

The server accepts only `GET` and `HEAD`, performs no directory listing, and serves
only documented browser-preview asset types. Directory index priority is
`index.html`, `index.htm`, `index.md`, then `index.markdown`; a request for an HTML
path can fall back to the same Markdown path.

The preview boundary is deliberately narrow:

- requested and physical paths must remain inside the resolved root;
- symlink and junction escapes are rejected and file identity is rechecked while
  reading;
- hidden path segments, credential/key names, private-key extensions, and
  non-preview file types are denied;
- request URLs are limited to 8,192 characters, files to 50 MiB, and concurrent
  requests to 16 by default;
- responses use `nosniff`, `no-referrer`, and `no-store` headers.

Missing paths produce HTTP 404, permission failures produce HTTP 403, and other
filesystem failures produce HTTP 500 instead of being disguised as missing files.

`--allow-network` changes only the bind policy. It does not add authentication or
TLS, so expose this development server only on a network you trust. A wildcard
`0.0.0.0` host accepts IPv4-literal Host headers, while `::` accepts IPv6-literal
Host headers; DNS hostnames receive HTTP 421 under those wildcard policies.

## `docblocks convert <input>`

```bash
# The fixed default set: DOCX, PPTX, PDF, HTML, and DBK
docblocks convert story.md

# Select linked-registry exports explicitly
docblocks convert report.docx --formats md,pdf,pptx --output-dir ./exports

# Apply linked Squisq authoring choices
docblocks convert story.md --theme cinematic --transform documentary
```

| Option                   | Default                  | Meaning                                                    |
| ------------------------ | ------------------------ | ---------------------------------------------------------- |
| `-o, --output-dir <dir>` | input parent             | Destination directory.                                     |
| `-f, --formats <list>`   | `docx,pptx,pdf,html,dbk` | Comma-separated linked-registry export IDs.                |
| `-t, --theme <id>`       | unset                    | Override the document theme; otherwise Squisq resolves it. |
| `--transform <style>`    | none                     | Squisq transform style to apply before export.             |
| `--allow-overwrite`      | off                      | Replace existing destination files instead of refusing.    |

Input is resolved by the linked Squisq CLI API. It accepts Markdown, Squisq JSON
Doc, DBK/ZIP containers, folders, and every import-capable registry format: DOCX,
PPTX, PDF, XLSX, CSV, and HTML in the current linked checkout. PPTX imports infer
theme/layout data by default, and linked narration/audio mappings are normalized
before conversion.

After a bounded input preflight, DocBlocks loads the source through the linked reader,
then calls the linked converter for each valid target sequentially. Unknown or import-only
format IDs are reported and skipped; the command
fails if no requested target is export-capable. Suggested output basenames come from
the linked converter. Input is limited to 1 GiB and 20,000 entries; each output is
limited to 512 MiB and all requested outputs together are limited to 1 GiB.

Because the output directory defaults to the input's own parent, `convert` never
replaces an existing file unless you ask it to. Every destination name is derived
before any conversion runs, so the command checks them all up front and refuses the
entire run — naming every conflicting path — if any already exists. One conflict
aborts all requested formats rather than exporting some and skipping others, so the
command never reports partial success: it either writes every format or none, and a
refusal exits with status 1. Pass `--allow-overwrite` to replace them, or send the
run elsewhere with `--output-dir`.

Each result is flushed to a same-directory staging file, so a failed write does not
truncate a previous output. Without `--allow-overwrite` the staged bytes are published
with an atomic create-if-absent link, which also refuses a destination that appeared
after the preflight check; with it, the staged file is renamed over the destination.

For every Markdown-shaped input—including DBK and registry imports that reconstruct
Markdown—DocBlocks applies transforms through its source-preserving projection. A
Squisq JSON Doc has no Markdown AST, so that path delegates the transform to the
linked registry-native conversion pipeline.

### Linked format registry

This catalog is read from the linked `createCliRegistry()` contract. Squisq Formats
provides the document formats; the linked Squisq CLI adds Node-only MP4 and GIF
exporters. Direction is significant: HTML ZIP, EPUB, MP4, and GIF are export-only.

<!-- BEGIN FORMAT CATALOG -->

| ID        | Import | Export |
| --------- | :----: | :----: |
| `md`      |  yes   |  yes   |
| `docx`    |  yes   |  yes   |
| `pdf`     |  yes   |  yes   |
| `pptx`    |  yes   |  yes   |
| `xlsx`    |  yes   |  yes   |
| `csv`     |  yes   |  yes   |
| `html`    |  yes   |  yes   |
| `htmlzip` |   no   |  yes   |
| `epub`    |   no   |  yes   |
| `dbk`     |  yes   |  yes   |
| `mp4`     |   no   |  yes   |
| `gif`     |   no   |  yes   |

<!-- END FORMAT CATALOG -->

`docblocks convert --formats mp4,gif` uses the linked registry's media defaults.
Use `docblocks video` when you need explicit MP4 frame rate, quality, orientation,
captions, or dimensions. Use the MCP surface when untrusted or very large inputs
need configurable read, concurrency, time, artifact, and report budgets.

## `docblocks video <input> [output]`

```bash
docblocks video story.md ./story.mp4 --quality high --orientation portrait
```

| Option                  | Default                | Meaning                                                     |
| ----------------------- | ---------------------- | ----------------------------------------------------------- |
| `-o, --output <path>`   | `<input-basename>.mp4` | Output path; takes precedence over positional `output`.     |
| `--fps <number>`        | `30`                   | Frames per second; linked validation permits 1 through 120. |
| `--quality <level>`     | `normal`               | `draft`, `normal`, or `high`.                               |
| `--orientation <value>` | `landscape`            | `landscape` or `portrait`.                                  |
| `--captions <style>`    | `off`                  | `off`, `standard`, or `social`.                             |
| `--width <pixels>`      | orientation default    | Override video width with a positive safe integer.          |
| `--height <pixels>`     | orientation default    | Override video height with a positive safe integer.         |
| `--allow-overwrite`     | off                    | Replace an existing output MP4 instead of refusing.         |

Input uses the same linked Squisq reader as `convert`, so import-capable Office,
PDF, spreadsheet, HTML, Markdown, JSON Doc, DBK/ZIP, and folder sources are valid.
The linked default dimensions are 1920x1080 landscape and 1080x1920 portrait.

The default output sits next to the input, so `video` matches `convert`: an existing
MP4 is never replaced unless `--allow-overwrite` is passed. The check runs before the
input is read and before any browser capture or FFmpeg encoding starts, and a refusal
exits with status 1.

Rendering requires Chromium and FFmpeg. Install Chromium with:

```bash
npx playwright install chromium
```

Squisq resolves FFmpeg from `SQUISQ_FFMPEG`, the process `PATH`, or an installed
`ffmpeg-static`, in that order.

## `docblocks themes` and `docblocks transforms`

These are live views of the linked Squisq authoring registries:

```bash
docblocks themes
docblocks transforms
```

Each unadorned ID is written on its own stdout line for scripting; the human-readable
heading is written to stderr. Do not maintain a second static list in DocBlocks.

## `docblocks parse <input>`

`parse` reads UTF-8 content, calls Squisq's `parseMarkdown`, and writes an exact
`{ stats, document }` object to stdout. For an input with one heading and one
paragraph, `stats` is:

```json
{
  "headingCount": 1,
  "paragraphCount": 1,
  "blockCount": 2
}
```

The counters describe top-level document children; `document` is the complete
linked Squisq `MarkdownDocument` syntax tree. The command is intended for UTF-8
Markdown content but does not enforce a filename extension, unlike the broader
linked input reader used by `convert` and `video`. Malformed UTF-8 is rejected.
Input is limited to 20 MiB and serialized JSON output to 128 MiB.

## `docblocks mcp`

```bash
docblocks mcp
docblocks mcp --allow-read ./documents --allow-write ./exports
```

The command starts one local stdio server. It begins with no filesystem roots and
keeps generated artifacts in a temporary, process-scoped store. The complete tool,
resource, prompt, authority, fidelity, and lifecycle contract is in the
[MCP architecture guide](mcp.md).

| Option                               |    Default | Hard ceiling |
| ------------------------------------ | ---------: | -----------: |
| `--allow-read <dir...>`              |       none |     64 roots |
| `--allow-write <dir...>`             |       none |     64 roots |
| `--max-concurrency <count>`          |          2 |           32 |
| `--operation-timeout-ms <ms>`        |    120,000 |    1,800,000 |
| `--max-input-bytes <bytes>`          |    100 MiB |        1 GiB |
| `--max-artifact-bytes <bytes>`       |    500 MiB |      500 MiB |
| `--max-artifact-total-bytes <bytes>` |      1 GiB |        4 GiB |
| `--max-artifacts <count>`            |         64 |        1,024 |
| `--artifact-ttl-ms <ms>`             | 30 minutes |     24 hours |
| `--max-resource-bytes <bytes>`       |     25 MiB |      100 MiB |
| `--max-report-bytes <bytes>`         |      8 MiB |       32 MiB |
| `--max-report-total-bytes <bytes>`   |     64 MiB |      256 MiB |

The operation timeout must be at least 1,000 ms. Numeric budgets are positive
integers, and aggregate artifact/report limits must be at least their per-item
limits. Graceful shutdown follows stdin closure, transport closure, SIGINT, or
SIGTERM; signal exits use conventional codes 130 and 143.

## Contributor assurance

From the repository root:

```bash
npm run build:cli
npm run test:mcp
npm run check:squisq-linked
npm run test:mcp:linked
npm run all
```

`check:squisq-linked` verifies physical sibling-package realpaths, linked build
freshness, Squisq source provenance, registry directions, and MCP format parity.
`test:mcp:linked` rebuilds and links the sibling checkout, runs focused upstream
format/media contracts, and runs the complete DocBlocks MCP suite against that
source. `npm run all` remains the canonical repository gate.

When a command or linked registry capability changes, update this guide and the
short package README in the same change. `packages/cli/test/documentation.test.ts`
keeps the documented command, MCP-tool, and format catalogs synchronized with the
runtime contracts.
