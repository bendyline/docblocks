import * as vscode from 'vscode';
import { MarkdownEditorPanel } from './markdownEditorPanel.js';

export class MarkdownEditorLauncher implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'docblocks.markdownEditor';

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken,
  ): Thenable<void> | void {
    if (token.isCancellationRequested) return;
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

function showOpenError(uri: vscode.Uri, error: unknown): Thenable<string | undefined> {
  return vscode.window.showErrorMessage(
    error instanceof Error ? error.message : `DocBlocks could not open ${uri.path}`,
  );
}
