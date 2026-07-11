import * as vscode from 'vscode';
import {
  VscodeDocumentSync,
  withApplyingEditFlag,
  type HostDocumentAdapter,
  type HostDocumentSnapshot,
} from './editSync.js';
import { handleExportMessage } from './exportBridge.js';
import { getEditorLocalResourceRoots, handleMediaMessage } from './mediaBridge.js';
import {
  parseWebviewToExtensionMessage,
  type DocumentConflictChoice,
  type ExtensionToWebviewMessage,
  type WebviewToExtensionMessage,
} from './messages.js';
import { getEditorHtml, getVscodeTheme } from './webviewHelper.js';

const KEEP_LOCAL_CHOICE = 'Keep DocBlocks Changes';
const USE_EXTERNAL_CHOICE = 'Use External Changes';

export class MarkdownEditorPanel {
  public static readonly viewType = 'docblocks.markdownPanel';

  private static readonly panels = new Map<string, MarkdownEditorPanel>();
  private static readonly closingSessions = new Set<Promise<void>>();

  private readonly disposables: vscode.Disposable[] = [];
  private readonly syncReady: Promise<VscodeDocumentSync>;
  private sync: VscodeDocumentSync | null = null;
  private unsubscribeSync: (() => void) | null = null;
  private isApplyingEdit = false;
  private webviewReady = false;
  private disposeStarted = false;
  private operationQueue: Promise<void> = Promise.resolve();

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
    this.syncReady = this.initializeSync();
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
    try {
      await editorPanel.syncReady;
    } catch (error: unknown) {
      MarkdownEditorPanel.panels.delete(key);
      panel.dispose();
      throw error;
    }
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

  /** Flush every host-owned draft when VS Code deactivates the extension. */
  public static async disposeAll(): Promise<void> {
    const panels = [...MarkdownEditorPanel.panels.values()];
    for (const editorPanel of panels) editorPanel.panel.dispose();
    await Promise.allSettled([...MarkdownEditorPanel.closingSessions]);
  }

  private async initializeSync(): Promise<VscodeDocumentSync> {
    const adapter: HostDocumentAdapter = {
      key: this.uri.toString(),
      read: () => this.readHostDocument(),
      replaceAndSave: (content) => this.replaceAndSaveHostDocument(content),
    };
    const sync = await VscodeDocumentSync.create(adapter, { autoSaveDelayMs: 300 });
    this.sync = sync;
    this.unsubscribeSync = sync.subscribe(() => {
      this.sendSessionState();
      this.updateTitle();
    });
    this.updateTitle();
    return sync;
  }

  private registerEventHandlers(): void {
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((value: unknown) => {
        const message = parseWebviewToExtensionMessage(value);
        if (!message) {
          void vscode.window.showErrorMessage('DocBlocks ignored an invalid editor message.');
          return;
        }
        this.queueOperation(() => this.handleMessage(message));
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.toString() !== this.uri.toString() || this.isApplyingEdit) return;
        this.document = event.document;
        const external = toHostSnapshot(event.document);
        this.queueOperation(async () => {
          const sync = await this.syncReady;
          const result = sync.observeExternal(external);
          if (result === 'applied') this.sendContent();
          if (result === 'conflict') {
            void vscode.window.showWarningMessage(
              `${getUriBasename(this.uri)} changed outside DocBlocks while local edits were pending. Resolve the conflict in the DocBlocks editor.`,
            );
          }
          this.sendSessionState();
          this.updateTitle();
        });
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri.toString() !== this.uri.toString()) return;
        this.document = document;
        this.updateTitle();
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (document.uri.toString() !== this.uri.toString()) return;
        this.updateTitle();
      }),
      vscode.window.onDidChangeActiveColorTheme(() => {
        this.sendTheme();
      }),
      this.panel.onDidDispose(() => {
        MarkdownEditorPanel.panels.delete(this.uri.toString());
        vscode.Disposable.from(...this.disposables).dispose();
        this.trackClose();
      }),
    );
  }

  private async handleMessage(message: WebviewToExtensionMessage): Promise<void> {
    const document = await this.ensureDocument();
    if (await handleMediaMessage(message, document, this.panel.webview)) return;
    if (await handleExportMessage(message, document, this.panel.webview, this.context)) return;

    const sync = await this.syncReady;
    switch (message.type) {
      case 'ready':
        this.webviewReady = true;
        this.sendContent();
        this.sendSessionState();
        this.sendTheme();
        break;

      case 'edit': {
        const acknowledgement = sync.acceptEdit(message);
        this.postMessage({
          type: 'editAcknowledged',
          sessionId: message.sessionId,
          clientRevision: acknowledgement.clientRevision,
          sessionRevision: acknowledgement.sessionRevision,
          accepted: acknowledgement.accepted,
          message: acknowledgement.message,
        });
        if (!acknowledgement.accepted) this.sendContent();
        break;
      }

      case 'save':
        await this.handleSave(message, sync);
        break;

      case 'resolveConflict':
        await this.handleConflictChoice(message.sessionId, message.choice, sync);
        break;
    }
  }

  private async handleSave(
    message: Extract<WebviewToExtensionMessage, { type: 'save' }>,
    sync: VscodeDocumentSync,
  ): Promise<void> {
    try {
      const snapshot = await sync.save(message);
      const state = sync.getSnapshot();
      this.postMessage({
        type: 'saveResult',
        sessionId: state.sessionId,
        requestId: message.requestId,
        ok: true,
        revision: snapshot.revision,
        persistedRevision: snapshot.persistedRevision,
        documentVersion: state.documentVersion,
        message: null,
      });
    } catch (error: unknown) {
      const state = sync.getSnapshot();
      const messageText = toError(error).message;
      this.postMessage({
        type: 'saveResult',
        sessionId: state.sessionId,
        requestId: message.requestId,
        ok: false,
        revision: state.session.revision,
        persistedRevision: state.session.persistedRevision,
        documentVersion: state.documentVersion,
        message: messageText,
      });
      await vscode.window.showErrorMessage(messageText);
    }
  }

  private async handleConflictChoice(
    sessionId: string,
    choice: DocumentConflictChoice,
    sync: VscodeDocumentSync,
  ): Promise<void> {
    if (sessionId !== sync.getSnapshot().sessionId) {
      this.sendContent();
      return;
    }

    try {
      await sync.resolveConflict(choice);
      if (choice === 'use-external') this.sendContent();
      this.sendSessionState();
    } catch (error: unknown) {
      await vscode.window.showErrorMessage(toError(error).message);
    }
  }

  private queueOperation(operation: () => Promise<void>): void {
    this.operationQueue = this.operationQueue
      .then(operation)
      .catch((error: unknown) =>
        vscode.window.showErrorMessage(
          error instanceof Error
            ? error.message
            : `DocBlocks could not update ${getUriBasename(this.uri)}`,
        ),
      )
      .then(() => undefined);
  }

  private async readHostDocument(): Promise<HostDocumentSnapshot> {
    const document = await this.ensureDocument();
    return toHostSnapshot(document);
  }

  private async replaceAndSaveHostDocument(content: string): Promise<HostDocumentSnapshot> {
    let document = await this.ensureDocument();
    if (document.getText() !== content) {
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
      document = await this.ensureDocument();
    }

    if (document.isDirty) {
      const didSave = await document.save();
      if (!didSave) {
        throw new Error(`VS Code could not save ${getUriBasename(this.uri)}`);
      }
      document = await this.ensureDocument();
    }

    this.document = document;
    this.updateTitle();
    return toHostSnapshot(document);
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

  private sendContent(): void {
    const sync = this.sync;
    if (!sync || !this.webviewReady) return;
    const snapshot = sync.getSnapshot();
    this.postMessage({
      type: 'setContent',
      content: snapshot.session.content,
      documentVersion: snapshot.baseDocumentVersion,
      fileName: getUriBasename(this.uri),
      sessionId: snapshot.sessionId,
      sessionRevision: snapshot.session.revision,
      acknowledgedClientRevision: snapshot.acknowledgedClientRevision,
    });
  }

  private sendSessionState(): void {
    const sync = this.sync;
    if (!sync || !this.webviewReady) return;
    const snapshot = sync.getSnapshot();
    this.postMessage({
      type: 'sessionState',
      sessionId: snapshot.sessionId,
      status: snapshot.session.status,
      revision: snapshot.session.revision,
      persistedRevision: snapshot.session.persistedRevision,
      acknowledgedClientRevision: snapshot.acknowledgedClientRevision,
      documentVersion: snapshot.documentVersion,
      error: snapshot.session.error?.message ?? null,
    });
  }

  private sendTheme(): void {
    if (!this.webviewReady) return;
    this.postMessage({
      type: 'themeChange',
      theme: getVscodeTheme(),
    });
  }

  private postMessage(message: ExtensionToWebviewMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private updateTitle(): void {
    const status = this.sync?.getSnapshot().session.status;
    const unsaved =
      this.document.isDirty ||
      status === 'dirty' ||
      status === 'saving' ||
      status === 'error' ||
      status === 'conflict';
    this.panel.title = `${unsaved ? '* ' : ''}${getUriBasename(this.uri)}`;
  }

  private trackClose(): void {
    if (this.disposeStarted) return;
    this.disposeStarted = true;
    const closing = this.flushAndDispose().finally(() => {
      MarkdownEditorPanel.closingSessions.delete(closing);
    });
    MarkdownEditorPanel.closingSessions.add(closing);
  }

  private async flushAndDispose(): Promise<void> {
    try {
      await this.operationQueue;
      const sync = await this.syncReady;
      try {
        await sync.prepareClose();
      } catch (error: unknown) {
        if (sync.getSnapshot().session.status !== 'conflict') throw error;
        const choice = await vscode.window.showWarningMessage(
          `${getUriBasename(this.uri)} changed outside DocBlocks. Choose which version to keep before the editor closes.`,
          { modal: true },
          KEEP_LOCAL_CHOICE,
          USE_EXTERNAL_CHOICE,
        );
        if (choice === KEEP_LOCAL_CHOICE) {
          await sync.resolveConflict('use-local');
          await sync.prepareClose();
        } else if (choice === USE_EXTERNAL_CHOICE) {
          await sync.resolveConflict('use-external');
          await sync.prepareClose();
        } else {
          await this.preserveDraftInUntitledDocument(sync.getSnapshot().session.content);
        }
      }
    } catch (error: unknown) {
      const draft = this.sync?.getSnapshot().session;
      if (draft && draft.persistedRevision < draft.revision) {
        try {
          await this.preserveDraftInUntitledDocument(draft.content);
        } catch {
          // The original save error below remains the actionable failure. A
          // shutdown host may no longer permit opening another editor.
        }
      }
      await vscode.window.showErrorMessage(
        `DocBlocks could not finish saving ${getUriBasename(this.uri)}: ${toError(error).message}`,
      );
    } finally {
      this.unsubscribeSync?.();
      this.unsubscribeSync = null;
      this.sync?.dispose();
      this.sync = null;
    }
  }

  private async preserveDraftInUntitledDocument(content: string): Promise<void> {
    const draft = await vscode.workspace.openTextDocument({ content, language: 'markdown' });
    await vscode.window.showTextDocument(draft, { preview: false });
    await vscode.window.showWarningMessage(
      `The unsaved DocBlocks draft for ${getUriBasename(this.uri)} was preserved in a new untitled editor.`,
    );
  }
}

function getFullDocumentRange(document: vscode.TextDocument): vscode.Range {
  return new vscode.Range(
    document.lineAt(0).range.start,
    document.lineAt(document.lineCount - 1).range.end,
  );
}

function toHostSnapshot(document: vscode.TextDocument): HostDocumentSnapshot {
  return { content: document.getText(), version: document.version };
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

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
