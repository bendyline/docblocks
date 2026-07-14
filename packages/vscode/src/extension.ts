import * as vscode from 'vscode';
import { MarkdownEditorLauncher } from './markdownEditorLauncher.js';
import { MarkdownEditorPanel } from './markdownEditorPanel.js';
import { SetupViewProvider } from './setupViewProvider.js';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      MarkdownEditorLauncher.viewType,
      new MarkdownEditorLauncher(context),
    ),
  );

  // Register the open editor command (shows picker dialog).
  context.subscriptions.push(
    vscode.commands.registerCommand('docblocks.openEditor', async () => {
      await MarkdownEditorPanel.pickAndOpen(context);
    }),
  );

  // Register the explorer/title context-menu command. When invoked from a
  // menu, VSCode passes the clicked resource URI as the first argument.
  // Fall back to the active editor's URI if invoked from the palette.
  context.subscriptions.push(
    vscode.commands.registerCommand('docblocks.openInDocBlocks', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        await MarkdownEditorPanel.pickAndOpen(context);
        return;
      }
      await MarkdownEditorPanel.open(context, target);
    }),
  );

  // Register the open setup command.
  context.subscriptions.push(
    vscode.commands.registerCommand('docblocks.openSetup', () => {
      SetupViewProvider.createOrShow(context);
    }),
  );

  // Internal target for the active panel's native document-status item.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      MarkdownEditorPanel.documentStatusCommand,
      async (uriValue: unknown) => {
        await MarkdownEditorPanel.handleDocumentStatusAction(uriValue);
      },
    ),
  );
}

export async function deactivate(): Promise<void> {
  await MarkdownEditorPanel.disposeAll();
}
