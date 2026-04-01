import * as vscode from 'vscode';
import { MarkdownEditorProvider } from './markdownEditorProvider.js';
import { SetupViewProvider } from './setupViewProvider.js';

export function activate(context: vscode.ExtensionContext) {
  // Register the custom markdown editor
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      MarkdownEditorProvider.viewType,
      new MarkdownEditorProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
      },
    ),
  );

  // Register the setup sidebar pane
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SetupViewProvider.viewType,
      new SetupViewProvider(context),
    ),
  );

  // Register the open editor command
  context.subscriptions.push(
    vscode.commands.registerCommand('docblocks.openEditor', async () => {
      const uris = await vscode.window.showOpenDialog({
        filters: { 'Markdown Files': ['md'] },
        canSelectMany: false,
      });
      if (uris && uris.length > 0) {
        await vscode.commands.executeCommand(
          'vscode.openWith',
          uris[0],
          MarkdownEditorProvider.viewType,
        );
      }
    }),
  );
}

export function deactivate() {
  // cleanup
}
