# Wiki articles

Use `[[foo]]` to refer to an article beside the current document, or
`[[reference/blah]]` for an article in a subfolder. By default the extension is
`.md`. In the shared shell, a workspace whose remembered New File type is
**Web page — Static** or **Web page — Interactive** defaults to `.html` and
keeps that output style. This preference is saved locally per workspace.
Existing targets in the preferred format win; otherwise an existing `.md`,
`.html`, or `.htm` article is reused. Explicit extensions address exactly that
file. Names may contain spaces or Unicode.

Use `[[foo|bar]]` to show **bar** while linking to **foo**. The friendly name
is literal text, and only the target determines which article opens or is
created. Missing targets show the friendly name as plain text in presentations.
In Markdown tables, escape the separator: `[[foo\|bar]]`.

In **Write** and **Source**, typing `[[` suggests nearby articles and folders.
Continue typing to filter, use the arrow keys to choose, and press Enter or Tab
to accept. Selecting a folder inserts its path and suggests its children;
selecting an article completes the link. Escape dismisses suggestions. Suggestions
stop after `|`, while writing the friendly name. They never create files or folders.

After completing a link, press **Ctrl+K** (**Cmd+K** on macOS) beside it, or
right-click it and choose **Edit wiki link**. The dialog identifies an internal
article link and shows its **Article target** and optional **Friendly name**
separately. Updating either preserves wiki syntax. Clear the friendly name to
show the article name again. The same dialog edits a wiki link under the cursor
in Source.

The shared shell uses its workspace index, including empty folders, and keeps
explicit extensions when needed to distinguish Markdown and HTML articles with
the same name. VS Code lists the requested folder and inserts explicit extensions.

In **Write**, follow the article button to open it. A missing article has a
dashed underline and a **Create article** label. Following it saves the source,
creates the article (and any missing parent folders), and opens the
article in Write. Typing, parsing, hovering, or presenting a link creates nothing.
An existing article is never overwritten, including when another writer creates
it between the existence check and the click.

HTML articles use the same outside-in creation path as New File: `foo.html`
is the public page and `foo_files/foo.md` is its editable Markdown companion.
Later content saves regenerate the HTML, resolving existing wiki targets to
public article URLs while leaving missing targets as plain text. Articles are
located beside the public page, never inside its companion folder. Other
New File types retain Markdown wiki creation. The VS Code Markdown editor
does not offer outside-in HTML creation.

In presentations, an existing target is a normal relative Markdown link. Missing
or unresolved targets retain their words as plain text, without brackets or a
creation action. Standalone renderers and exports with no article resolver also
use this plain-text fallback. Wiki syntax remains in the saved Markdown.

Wiki paths are literal descendant names. Absolute paths, `.` and `..` segments,
URLs, backslashes, percent escapes, control characters, and Windows device names
are rejected. File access still passes through the workspace provider's containment
checks. Code fences, inline code, and escaped brackets are not wiki links.
Heading fragments, backlinks, and renaming references are not part of this syntax.

The shared shell enables this for site, desktop, and mobile workspaces. The VS Code
webview uses a validated request/response bridge to its extension host; creation
requires a trusted, writable workspace. Both hosts flush source edits before
opening an article and retain storage failures as errors.

## Squisq integration

`EditorShell` accepts optional `wikiLinks: WikiLinkSupport`, exported by
`@bendyline/squisq/markdown`. The host supplies `exists(target)` and
`open(target, { create })`, plus optional `resolve(target)` returning an encoded
article URL or null. It owns workspace authority, save ordering, exclusive
creation, and navigation. This is separate from `workspaceContainer`, which
DocBlocks roots at the document's media/history sidecar.

Optional `suggest(query)` enables autocomplete in both editing views. It returns
up to 20 `{ target, label, kind: 'article' | 'folder' }` entries; folder targets
end in `/`. Targets are relative to the current article, and lookups must not
mutate storage. The editors discard stale results and validate insertions.

Core parses a wiki reference as a `MarkdownLink` with `wikiTarget`, optional
`wikiLabel`, and an initially
empty `url`. `resolveWikiLinks(document, exists)` produces a presentation copy with
URLs only for existing targets; serialization preserves the target and friendly
name as wiki syntax. It performs
at most 256 distinct lookups, sequentially. The editor ignores obsolete async
results. DocBlocks shares queued existence checks between the Write nodes and
presentation resolver and invalidates them when the workspace index changes.

These changes require the accompanying Squisq source changes. In sibling-checkout
development, build/link Squisq before building DocBlocks; a release needs matching
published Squisq packages.
