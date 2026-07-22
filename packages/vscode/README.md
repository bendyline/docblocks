# DocBlocks for VS Code

Edit Markdown visually without leaving VS Code. DocBlocks adds a rich editor for `*.md` files while keeping ordinary Markdown as the source of truth.

[Learn more about DocBlocks for VS Code](https://docblocks.com/vscode/)

## Highlights

- Write in a rich document editor powered by Squisq.
- Switch between **Editor**, **Markdown**, and **Play** views at any time.
- Preview the document as a video, slideshow, document, or page.
- Use images, audio, and video from the document's sibling `<name>_files/` folder.
- Export through the built-in DocBlocks export experience.
- Work in desktop VS Code or VS Code for the Web.
- Keep VS Code's familiar tabs, file explorer, themes, save flow, and conflict handling.

## Getting started

1. Install the extension.
2. Open a `.md` file. DocBlocks is registered as its default custom editor.
3. If needed, right-click a Markdown file and choose **Open in DocBlocks**, or run **DocBlocks: Open Editor** from the Command Palette.
4. Use **Editor**, **Markdown**, and **Play** in the editor header to choose how you work.
5. Save normally with **File > Save** or `Ctrl+S` / `Cmd+S`.

Your Markdown remains a regular text file that works with source control and other editors. Clean changes made outside DocBlocks reload automatically. If an external edit overlaps an unsaved local draft, DocBlocks shows an explicit conflict instead of silently replacing either version.

## Media and export

Media referenced by a document is resolved from its sibling asset folder. For example, assets for `guide.md` live in `guide_files/`.

VS Code webviews cannot reliably grant camera, microphone, or screen-capture permissions, so recording is not offered inside the extension. Existing image, audio, and video files still render normally.

When exporting, you can edit the suggested file name or use the adjacent picker to choose another folder. Existing files go through VS Code's normal overwrite confirmation.

## Optional CLI and MCP tools

The editor works on its own. To add DocBlocks command-line conversion, video tools, or the local MCP server, run **DocBlocks: Open DocBlocks Tools (CLI+MCP) Setup**.

The guided setup installs `@bendyline/docblocks-cli` as a workspace development dependency, not as a global package. MCP setup preserves existing servers and does not grant filesystem access automatically; add explicit read or write roots only when you intend to expose them.

## Commands

| Command                                           | What it does                                           |
| ------------------------------------------------- | ------------------------------------------------------ |
| `DocBlocks: Open Editor`                          | Opens the active Markdown file in DocBlocks            |
| `Open in DocBlocks`                               | Opens a Markdown file from its context menu            |
| `DocBlocks: Open DocBlocks Tools (CLI+MCP) Setup` | Opens guided setup for the optional CLI and MCP server |

## Settings

Open **DocBlocks for VS Code settings** from the gear beside the export destination, or search Settings for `DocBlocks`.

| Setting                            | Purpose                                        | Default |
| ---------------------------------- | ---------------------------------------------- | ------- |
| `docblocks.autoSave`               | Saves 20 seconds after the most recent edit    | `false` |
| `docblocks.accentColor`            | Sets the editor control accent                 | `brown` |
| `docblocks.writeCanvasTextSize`    | Sets the writing canvas text size              | `16`    |
| `docblocks.writeCanvasLineSpacing` | Sets the writing canvas line-height multiplier | `1.7`   |

Manual Save and the editor's close-time safety flush remain active when automatic save is disabled.

## License

MIT
