import * as vscode from 'vscode';
import { MarkdownEditorLauncher } from './markdownEditorLauncher.js';
import { MarkdownEditorPanel } from './markdownEditorPanel.js';
import { SetupViewProvider } from './setupViewProvider.js';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      MarkdownEditorLauncher.viewType,
      new MarkdownEditorLauncher(context),
      {
        supportsMultipleEditorsPerDocument: false,
        // The default *.md route must retain the same webview context as the
        // command-opened route (MarkdownEditorPanel.openDocument). Without
        // this, hiding the tab destroys the iframe: the host session and the
        // recovery journal still carry the content, but the Squisq shell
        // remounts from setContent, so undo history, selection, scroll, and
        // find state are lost on every tab switch and Monaco is re-downloaded
        // and re-parsed. Retaining costs the hidden editor's memory, which is
        // the right trade for a document editor whose undo stack is user data.
        webviewOptions: { retainContextWhenHidden: true },
      },
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
      SetupViewProvider.createOrShow();
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
