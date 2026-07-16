import * as vscode from 'vscode';
import { HOST_WIRE_LIMITS } from '@bendyline/docblocks/host';
import { getUriBasename } from './documentAuthority.js';
import { MarkdownEditorPanel } from './markdownEditorPanel.js';

const REOPEN_WITH_TEXT_EDITOR = 'Reopen with Text Editor';

/** VS Code's built-in text editor, the fallback for what DocBlocks cannot open. */
const TEXT_EDITOR_VIEW_TYPE = 'default';

export class MarkdownEditorLauncher implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'docblocks.markdownEditor';

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken,
  ): Thenable<void> | void {
    if (token.isCancellationRequested) return;

    // DocBlocks claims every *.md file with `priority: "default"`, so this is
    // the editor VS Code opens when the user clicks a markdown file. A document
    // the webview bridge cannot carry must therefore not reject the resolve:
    // that renders VS Code's own failure on a dead tab, on top of our toast,
    // and leaves the file with no way to open at all. Explain the limit in the
    // panel itself and offer the built-in text editor instead.
    if (exceedsEditorSizeLimit(document)) {
      renderOversizeNotice(document, webviewPanel);
      void offerTextEditorFallback(document);
      return;
    }

    try {
      return MarkdownEditorPanel.attachCustomEditor(this.context, document, webviewPanel).catch(
        async (error: unknown) => {
          await showOpenError(document.uri, error);
          throw error;
        },
      );
    } catch (error: unknown) {
      void showOpenError(document.uri, error);
      throw error;
    }
  }
}

/**
 * Mirrors the guard in MarkdownEditorPanel's `toHostSnapshot`, which is the
 * throw that would otherwise tear the panel down. Both measure UTF-16 code
 * units so a document that passes here cannot fail there.
 */
export function exceedsEditorSizeLimit(document: vscode.TextDocument): boolean {
  return document.getText().length > HOST_WIRE_LIMITS.documentCharacters;
}

function renderOversizeNotice(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
  // Static explanation only: no scripts, and nothing to load from disk.
  panel.webview.options = { enableScripts: false, localResourceRoots: [] };
  panel.webview.html = getOversizeNoticeHtml(getDisplayBasename(document.uri));
}

async function offerTextEditorFallback(document: vscode.TextDocument): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    `${getDisplayBasename(document.uri)} is larger than the ${formatMegabytes(
      HOST_WIRE_LIMITS.documentCharacters,
    )} DocBlocks editor limit.`,
    REOPEN_WITH_TEXT_EDITOR,
  );
  if (choice !== REOPEN_WITH_TEXT_EDITOR) return;
  try {
    await vscode.commands.executeCommand(
      'vscode.openWith',
      document.uri,
      TEXT_EDITOR_VIEW_TYPE,
      vscode.ViewColumn.Active,
    );
  } catch (error: unknown) {
    await showOpenError(document.uri, error);
  }
}

function getOversizeNoticeHtml(fileName: string): string {
  const limit = escapeHtml(formatMegabytes(HOST_WIRE_LIMITS.documentCharacters));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <style>
    body {
      margin: 0;
      padding: 48px 24px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
    }
    main { max-width: 34rem; margin: 0 auto; }
    h1 { font-size: 1.25rem; font-weight: 600; }
    p { line-height: 1.5; }
    .hint { color: var(--vscode-descriptionForeground); }
    code { font-family: var(--vscode-editor-font-family, monospace); }
  </style>
</head>
<body>
  <main role="document">
    <h1>This document is too large for DocBlocks</h1>
    <p>${escapeHtml(fileName)} exceeds the ${limit} limit of the DocBlocks editor.</p>
    <p class="hint">
      Open it with VS Code's built-in text editor instead: right-click the file and choose
      <code>Open With&hellip;</code> &rarr; <code>Text Editor</code>.
    </p>
  </main>
</body>
</html>`;
}

function formatMegabytes(characters: number): string {
  return `${Math.floor(characters / (1024 * 1024))} MB`;
}

function getDisplayBasename(uri: vscode.Uri): string {
  return getUriBasename(uri).slice(0, 255);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

function showOpenError(uri: vscode.Uri, error: unknown): Thenable<string | undefined> {
  return vscode.window.showErrorMessage(
    error instanceof Error ? error.message : `DocBlocks could not open ${uri.path}`,
  );
}
