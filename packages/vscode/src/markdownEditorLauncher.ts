import * as vscode from 'vscode';
import { MarkdownEditorPanel } from './markdownEditorPanel.js';

export class MarkdownEditorLauncher implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'docblocks.markdownEditor';

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken,
  ): void {
    const viewColumn = webviewPanel.viewColumn ?? vscode.ViewColumn.Active;

    // The custom editor exists only to make DocBlocks the default for Markdown.
    // VS Code must first finish resolving its webview, so perform the handoff
    // on the next turn. Create the standalone panel before disposing the route
    // so VS Code never observes a disposed overlay during resolution.
    setTimeout(() => {
      if (token.isCancellationRequested) return;

      let ready: Promise<void>;
      try {
        ready = MarkdownEditorPanel.openDocument(this.context, document, viewColumn);
      } catch (error: unknown) {
        void showOpenError(document.uri, error);
        return;
      }

      webviewPanel.dispose();
      void ready.catch((error: unknown) => showOpenError(document.uri, error));
    }, 0);
  }
}

function showOpenError(uri: vscode.Uri, error: unknown): Thenable<string | undefined> {
  return vscode.window.showErrorMessage(
    error instanceof Error ? error.message : `DocBlocks could not open ${uri.path}`,
  );
}
