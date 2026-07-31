# DocBlocks CLI reference

This is the authoritative guide to the current `docblocks` command-line surface.
It documents the behavior shipped from `packages/cli`, including the capabilities
delegated to the linked Squisq checkout. The separate [MCP architecture
guide](mcp.md) is authoritative for the protocol started by `docblocks mcp`.

The executable requires Node.js 22.22.2+, 24.15.0+, or 26+ and is published as
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

| Option                             | Default | Meaning                                                     |
| ---------------------------------- | ------- | ----------------------------------------------------------- |
| `-i, --input <dir>`                | `.`     | Source directory.                                           |
| `-o, --output <dir>`               | `dist`  | Generated HTML directory.                                   |
| `-t, --theme <id>`                 | unset   | Override the document theme; otherwise Squisq resolves it.  |
| `--max-input-bytes <bytes>`        | 20 MiB  | Maximum bytes in one Markdown input.                        |
| `--max-total-input-bytes <bytes>`  | 512 MiB | Maximum aggregate Markdown input bytes.                     |
| `--max-output-bytes <bytes>`       | 128 MiB | Maximum bytes in one generated HTML file.                   |
| `--max-total-output-bytes <bytes>` | 1 GiB   | Maximum aggregate generated HTML bytes.                     |
| `--allow-large-build`              | off     | Disable default byte budgets for an explicitly trusted run. |

The command recursively finds `.md` and `.markdown` files, sorts them, preserves
their relative directory structure, and replaces each extension with `.html`. It
fails when the input is not a directory or contains no Markdown files. Traversal
is sequential and stops after 100,000 filesystem entries or 64 directory levels.
Input sizes are preflighted before the output directory is created, and generated
HTML is checked before each write. Explicit numeric limits still apply when
`--allow-large-build` is present; the flag only disables the defaults. Traversal,
permission and I/O failures remain errors rather than being reported as absence.

The render path is shared with `serve`: DocBlocks asks Squisq to parse Markdown,
project it into the Squisq document model, and export HTML, then embeds Squisq's
standalone player bundle. Ordinary fenced code blocks include the player's Copy
control; Mermaid fences remain diagrams. Referenced local images are embedded only after physical
containment checks. The default image budget is 100 images, 20 MiB per image, and
50 MiB in aggregate. Every image dropped for exceeding one of those budgets is named
on stderr with the reason, so a document whose images silently fail to embed reports
itself instead of producing valid-looking HTML with invisibly broken images.

## `docblocks serve`

```bash
docblocks serve --dir ./docs --port 3000
```

| Option                   | Default     | Meaning                                                    |
| ------------------------ | ----------- | ---------------------------------------------------------- |
| `-p, --port <port>`      | `3000`      | Listening port; `0` asks the OS for an ephemeral port.     |
| `-d, --dir <dir>`        | `.`         | Directory to preview.                                      |
| `-t, --theme <id>`       | unset       | Override the document theme; otherwise Squisq resolves it. |
| `--host <host>`          | `127.0.0.1` | Interface to bind.                                         |
| `--allow-network`        | off         | Required for a non-loopback host.                          |
| `--allow-host <host...>` | none        | Extra Host header names this server answers to (max 32).   |

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
The cause of a 500 is written to stderr — a bad theme ID, a parser failure, or an
embedded-asset failure names itself in the terminal rather than only showing the
browser a bare "Internal server error".

### Host header policy

The server answers only to authorities it was actually reached by. This is its
DNS-rebinding defense and cannot be disabled: a rebinding attack works by giving
an attacker-controlled _name_ a DNS record pointing at this server, so refusing an
unexpected Host keeps the attacker's page from reading preview responses. A
rejected request receives HTTP 421 whose body explains the policy and lists the
accepted names.

| Bind                           | Accepted Host headers on the listening port            |
| ------------------------------ | ------------------------------------------------------ |
| loopback (default `127.0.0.1`) | any loopback alias: `localhost`, `127.0.0.0/8`, `::1`  |
| wildcard `0.0.0.0` or `::`     | any IP literal of either family, plus loopback aliases |
| a specific non-loopback host   | exactly that host                                      |

Loopback aliases are interchangeable because they name only the local machine and
cannot be repointed by DNS, so `http://localhost:3000` works against the default
bind. A public name that merely resolves to a loopback address is still refused.
IP literals are accepted under a wildcard bind because rebinding requires a name;
an IP-literal origin is already isolated by the same-origin policy.

A wildcard bind cannot know its own hostnames, so reaching it by hostname requires
naming that hostname explicitly:

```bash
docblocks serve --host 0.0.0.0 --allow-network --allow-host my-laptop.lan
```

`--allow-host` grants exactly the names given, never their subdomains. Blanket
acceptance of any Host under `--allow-network` is deliberately not offered: it
would surrender the rebinding defense on precisely the servers other machines can
reach.

`--allow-network` changes only the bind policy. It does not add authentication or
TLS, so expose this development server only on a network you trust.

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
then calls the linked converter for each valid target sequentially. Suggested output
basenames come from the linked converter. Input is limited to 1 GiB and 20,000 entries;
each output is limited to 512 MiB and all requested outputs together are limited to 1 GiB.

`--formats` is a precise instruction, so the run is refused before any conversion when
an entry cannot be honored: an unknown or non-exportable ID fails with exit status 1
rather than being skipped under a success status, and a repeated ID (`-f pdf,pdf`) is
rejected as a duplicate target rather than converting and publishing the same
destination twice. This matches the MCP `convert_document` contract. The built-in
default set is DocBlocks' own choice rather than the caller's, so an unqualified
`docblocks convert` still reports and skips a default whose exporter the linked
registry no longer provides; it fails only if no default target is export-capable.

Because the output directory defaults to the input's own parent, `convert` never
replaces an existing file unless you ask it to. Every destination name is derived
before any conversion runs, so the command checks them all up front and refuses the
entire run — naming every conflicting path — if any already exists. One conflict
aborts all requested formats rather than exporting some and skipping others, so the
command never reports partial success: it either writes every format or none, and a
refusal exits with status 1. Pass `--allow-overwrite` to replace them, or send the
run elsewhere with `--output-dir`.

Every target is converted before publication begins. The complete bounded batch is
then flushed into a private same-filesystem staging directory. Without
`--allow-overwrite`, staged files are published with atomic create-if-absent links,
which also refuse a destination that appeared after preflight. With overwrite enabled,
existing destinations are first moved to recoverable backups. A later commit failure
or cancellation removes newly published files and restores every backup; if restoration
itself fails, the error names the preserved recovery directory.

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
| `-o, --output <path>`   | `<input-basename>.mp4` | Output path; mutually exclusive with positional `output`.   |
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

Name the destination positionally or with `-o`, never both: supplying both is refused
with exit status 1 rather than silently discarding one of two conflicting instructions.

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

For durable output, agents call `list_roots` before drafting. If no returned root is
write-enabled, the server must be restarted with `--allow-write`; the MCP workflow
does not fall back to the direct `convert` CLI command. For PPTX authoring, a
level-one heading creates each deliberate slide boundary by itself; agents should
not add `---` between slide headings unless a visible horizontal rule is intended.
MCP guidance asks agents to infer theme and Squisq Summarize style from the brief,
choose for the user, and ask at most one high-level style question only when the
choice is materially ambiguous.

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
