import * as vscode from 'vscode';
import { withApplyingEditFlag } from './editSync.js';
import { handleExportMessage } from './exportBridge.js';
import { getEditorLocalResourceRoots, handleMediaMessage } from './mediaBridge.js';
import type { WebviewToExtensionMessage } from './messages.js';
import { getEditorHtml, getVscodeTheme } from './webviewHelper.js';

export class MarkdownEditorPanel {
  public static readonly viewType = 'docblocks.markdownPanel';

  private static readonly panels = new Map<string, MarkdownEditorPanel>();

  private readonly disposables: vscode.Disposable[] = [];
  private isApplyingEdit = false;
  private messageQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly uri: vscode.Uri,
    private document: vscode.TextDocument,
    private readonly panel: vscode.WebviewPanel,
  ) {
    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: getEditorLocalResourceRoots(this.context.extensionUri, this.uri),
    };
    this.panel.iconPath = vscode.Uri.joinPath(
      this.context.extensionUri,
      'resources',
      'docblocks-icon.svg',
    );
    this.panel.webview.html = getEditorHtml(this.panel.webview, this.context.extensionUri);
    this.updateTitle();
    this.registerEventHandlers();
  }

  public static async open(context: vscode.ExtensionContext, uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    const existingPanel = MarkdownEditorPanel.panels.get(key);
    if (existingPanel) {
      existingPanel.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    const document = await vscode.workspace.openTextDocument(uri);
    const panel = vscode.window.createWebviewPanel(
      MarkdownEditorPanel.viewType,
      getUriBasename(uri),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: getEditorLocalResourceRoots(context.extensionUri, uri),
        retainContextWhenHidden: true,
      },
    );

    const editorPanel = new MarkdownEditorPanel(context, uri, document, panel);
    MarkdownEditorPanel.panels.set(key, editorPanel);
  }

  public static async pickAndOpen(context: vscode.ExtensionContext): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      filters: { 'Markdown Files': ['md'] },
      canSelectMany: false,
    });
    const target = uris?.[0];
    if (!target) return;
    await MarkdownEditorPanel.open(context, target);
  }

  private registerEventHandlers(): void {
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => {
        this.queueMessage(message);
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.toString() !== this.uri.toString()) return;
        this.document = event.document;
        this.updateTitle();
        if (this.isApplyingEdit) return;
        this.sendContent();
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri.toString() !== this.uri.toString()) return;
        this.document = document;
        this.updateTitle();
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (document.uri.toString() !== this.uri.toString()) return;
        void this.refreshDocument();
      }),
      vscode.window.onDidChangeActiveColorTheme(() => {
        this.sendTheme();
      }),
      this.panel.onDidDispose(() => {
        MarkdownEditorPanel.panels.delete(this.uri.toString());
        vscode.Disposable.from(...this.disposables).dispose();
      }),
    );
  }

  private async handleMessage(message: WebviewToExtensionMessage): Promise<void> {
    const document = await this.ensureDocument();
    if (await handleMediaMessage(message, document, this.panel.webview)) return;
    if (await handleExportMessage(message, document, this.panel.webview, this.context)) return;

    switch (message.type) {
      case 'ready':
        await this.refreshDocument();
        this.sendContent();
        this.sendTheme();
        break;

      case 'edit':
        await this.applyContent(message.content);
        await this.saveDocument();
        break;

      case 'save':
        await this.saveContent(message.content);
        break;
    }
  }

  private async applyContent(content: string): Promise<void> {
    const document = await this.ensureDocument();
    if (document.getText() === content) {
      this.updateTitle();
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, getFullDocumentRange(document), content);

    await withApplyingEditFlag(
      (nextIsApplyingEdit) => {
        this.isApplyingEdit = nextIsApplyingEdit;
      },
      async () => {
        const didApply = await vscode.workspace.applyEdit(edit);
        if (!didApply) {
          throw new Error(`VS Code rejected the DocBlocks edit for ${getUriBasename(this.uri)}`);
        }
      },
    );

    this.document = await this.ensureDocument();
    this.updateTitle();
  }

  private async saveContent(content: string): Promise<void> {
    try {
      await this.applyContent(content);
      await this.saveDocument();
    } catch (error) {
      await vscode.window.showErrorMessage(
        error instanceof Error ? error.message : `Could not save ${getUriBasename(this.uri)}`,
      );
    }
  }

  private queueMessage(message: WebviewToExtensionMessage): void {
    this.messageQueue = this.messageQueue
      .then(() => this.handleMessage(message))
      .catch((error: unknown) =>
        vscode.window.showErrorMessage(
          error instanceof Error
            ? error.message
            : `DocBlocks could not update ${getUriBasename(this.uri)}`,
        ),
      )
      .then(() => undefined);
  }

  private async saveDocument(): Promise<void> {
    const document = await this.ensureDocument();
    if (document.isDirty) {
      const didSave = await document.save();
      if (!didSave) {
        throw new Error(`VS Code could not save ${getUriBasename(this.uri)}`);
      }
    }
    this.document = await this.ensureDocument();
    this.updateTitle();
  }

  private async ensureDocument(): Promise<vscode.TextDocument> {
    const openDocument = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === this.uri.toString(),
    );
    if (openDocument) {
      this.document = openDocument;
      return openDocument;
    }

    this.document = await vscode.workspace.openTextDocument(this.uri);
    return this.document;
  }

  private async refreshDocument(): Promise<void> {
    this.document = await this.ensureDocument();
    this.updateTitle();
  }

  private sendContent(): void {
    void this.panel.webview.postMessage({
      type: 'setContent',
      content: this.document.getText(),
      version: this.document.version,
      fileName: getUriBasename(this.uri),
    });
  }

  private sendTheme(): void {
    void this.panel.webview.postMessage({
      type: 'themeChange',
      theme: getVscodeTheme(),
    });
  }

  private updateTitle(): void {
    const dirtyPrefix = this.document.isDirty ? '* ' : '';
    this.panel.title = `${dirtyPrefix}${getUriBasename(this.uri)}`;
  }
}

function getFullDocumentRange(document: vscode.TextDocument): vscode.Range {
  return new vscode.Range(
    document.lineAt(0).range.start,
    document.lineAt(document.lineCount - 1).range.end,
  );
}

function getUriBasename(uri: vscode.Uri): string {
  const slash = uri.path.lastIndexOf('/');
  const raw = slash === -1 ? uri.path : uri.path.slice(slash + 1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
