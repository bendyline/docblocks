import * as vscode from 'vscode';
import { getEditorHtml, getVscodeTheme } from './webviewHelper.js';
import type { WebviewToExtensionMessage } from './messages.js';

export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'docblocks.markdownEditor';

  constructor(private readonly context: vscode.ExtensionContext) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')],
    };

    webviewPanel.webview.html = getEditorHtml(webviewPanel.webview, this.context.extensionUri);

    // Track whether we're applying an edit from the webview to prevent echo
    let isApplyingEdit = false;
    let documentVersion = document.version;

    // Send content to webview
    function sendContent() {
      documentVersion = document.version;
      webviewPanel.webview.postMessage({
        type: 'setContent',
        content: document.getText(),
        version: documentVersion,
      });
    }

    // Send theme to webview
    function sendTheme() {
      webviewPanel.webview.postMessage({
        type: 'themeChange',
        theme: getVscodeTheme(),
      });
    }

    // Listen for webview messages
    const messageDisposable = webviewPanel.webview.onDidReceiveMessage(
      async (msg: WebviewToExtensionMessage) => {
        switch (msg.type) {
          case 'ready':
            sendContent();
            sendTheme();
            break;

          case 'edit': {
            if (document.getText() === msg.content) return;

            isApplyingEdit = true;
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
              document.uri,
              new vscode.Range(
                document.lineAt(0).range.start,
                document.lineAt(document.lineCount - 1).range.end,
              ),
              msg.content,
            );
            await vscode.workspace.applyEdit(edit);
            isApplyingEdit = false;
            break;
          }
        }
      },
    );

    // Listen for external document changes (undo, external edits)
    const changeDisposable = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      if (isApplyingEdit) return;
      sendContent();
    });

    // Listen for theme changes
    const themeDisposable = vscode.window.onDidChangeActiveColorTheme(() => {
      sendTheme();
    });

    webviewPanel.onDidDispose(() => {
      messageDisposable.dispose();
      changeDisposable.dispose();
      themeDisposable.dispose();
    });
  }
}
