import * as vscode from 'vscode';
import { MarkdownEditorPanel } from './markdownEditorPanel.js';

export class MarkdownEditorLauncher implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'docblocks.markdownEditor';

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    webviewPanel.webview.html = getLauncherHtml();
    void MarkdownEditorPanel.open(this.context, document.uri).then(
      () => {
        setTimeout(() => webviewPanel.dispose(), 250);
      },
      (error: unknown) => {
        void vscode.window.showErrorMessage(
          error instanceof Error ? error.message : `DocBlocks could not open ${document.uri.path}`,
        );
      },
    );
  }
}

function getLauncherHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Opening DocBlocks</title>
  </head>
  <body>Opening DocBlocks...</body>
</html>`;
}
