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

  // Register the open editor command (shows picker dialog)
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

  // Register the explorer/title context-menu command. When invoked from a
  // menu, VSCode passes the clicked resource URI as the first argument.
  // Fall back to the active editor's URI if invoked from the palette.
  context.subscriptions.push(
    vscode.commands.registerCommand('docblocks.openInDocBlocks', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) return;
      await vscode.commands.executeCommand(
        'vscode.openWith',
        target,
        MarkdownEditorProvider.viewType,
      );
    }),
  );

  // Register the open setup command (opens the panel form — kept for
  // users invoking the explicit "DocBlocks: Open Setup" command).
  context.subscriptions.push(
    vscode.commands.registerCommand('docblocks.openSetup', () => {
      SetupViewProvider.createOrShow(context);
    }),
  );

  // Register the sidebar setup view (activity bar → DocBlocks pane).
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SetupViewProvider.viewType,
      new SetupViewProvider(context),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );
}

export function deactivate() {
  // cleanup
}
