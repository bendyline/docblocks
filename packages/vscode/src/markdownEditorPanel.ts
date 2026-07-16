import * as vscode from 'vscode';
import { HOST_WIRE_LIMITS } from '@bendyline/docblocks/host';
import {
  DEFAULT_VSCODE_WRITE_CANVAS_SETTINGS,
  isDocBlocksAccentColor,
  isDocBlocksWriteCanvasLineSpacing,
  isDocBlocksWriteCanvasTextSize,
  parseWebviewToExtensionMessage,
  type DocumentConflictChoice,
  type ExtensionToWebviewMessage,
  type VscodeEditorSettings,
  type WebviewToExtensionMessage,
} from '@bendyline/docblocks/vscode';
import {
  HostDocumentChangedError,
  VscodeDocumentSync,
  withApplyingEditFlag,
  type HostDocumentAdapter,
  type HostDocumentSnapshot,
  type SaveParticipantPolicy,
} from './editSync.js';
import { getUriBasename } from './documentAuthority.js';
import {
  formatConflictResolutionDetail,
  getDocumentStatusBarPresentation,
} from './documentStatusBar.js';
import { handleExportMessage } from './exportBridge.js';
import { toError } from './toError.js';
import { ExportTargetGrantRegistry, type ExportGrantScope } from './exportGrants.js';
import { drainsAfterPanelDispose, EditorMessageQueue } from './editorMessageQueue.js';
import { LatestDocumentEditQueue, type WebviewEditMessage } from './latestDocumentEditQueue.js';
import { getEditorLocalResourceRoots, handleMediaMessage } from './mediaBridge.js';
import { getEditorHtml, getNonce, getVscodeTheme } from './webviewHelper.js';
import { resolveEditorLinkTarget } from './editorLinkNavigation.js';

const KEEP_LOCAL_CHOICE = 'Keep DocBlocks Changes';
const USE_EXTERNAL_CHOICE = 'Use VS Code Buffer';
const MAX_PENDING_OPERATIONS = 128;
const MAX_PENDING_WIRE_CHARACTERS = HOST_WIRE_LIMITS.base64Characters;

/**
 * Everything the bounded message queue can carry.
 *
 * Edits are diverted to {@link LatestDocumentEditQueue} at ingress and never
 * reach this queue, so excluding them here keeps the queue's handlers provably
 * exhaustive over exactly the messages that can arrive.
 */
type QueuedWebviewMessage = Exclude<WebviewToExtensionMessage, { type: 'edit' }>;

type EditorPanelQueueEntry =
  | { kind: 'webview'; message: QueuedWebviewMessage }
  | { kind: 'external-change' };

export class MarkdownEditorPanel {
  public static readonly viewType = 'docblocks.markdownPanel';
  public static readonly documentStatusCommand = 'docblocks.documentStatusAction';

  private static readonly panels = new Map<string, MarkdownEditorPanel>();
  private static readonly closingSessions = new Set<Promise<void>>();
  private static readonly exportGrants = new ExportTargetGrantRegistry<vscode.Uri>();

  private readonly disposables: vscode.Disposable[] = [];
  private readonly syncReady: Promise<VscodeDocumentSync>;
  private sync: VscodeDocumentSync | null = null;
  private unsubscribeSync: (() => void) | null = null;
  private isApplyingEdit = false;
  private webviewReady = false;
  private disposeStarted = false;
  private readonly messageQueue: EditorMessageQueue<EditorPanelQueueEntry>;
  private readonly latestEditQueue: LatestDocumentEditQueue;
  private invalidMessageWarningShown = false;
  private panelDisposed = false;
  private readonly exportGrantScope: ExportGrantScope;
  private readonly statusBarItem: vscode.StatusBarItem;
  private conflictPrompt: Promise<void> | null = null;
  private externalChangePending = false;
  private externalChangeQueued = false;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly uri: vscode.Uri,
    private document: vscode.TextDocument,
    private readonly panel: vscode.WebviewPanel,
  ) {
    this.exportGrantScope = { panelId: getNonce(), documentUri: this.uri.toString() };
    this.messageQueue = new EditorMessageQueue({
      maxPendingOperations: MAX_PENDING_OPERATIONS,
      maxPendingWireCharacters: MAX_PENDING_WIRE_CHARACTERS,
      estimateWireCharacters: (entry) =>
        entry.kind === 'webview' ? estimateWireCharacters(entry.message) : 0,
      drainAfterDispose: (entry) =>
        entry.kind === 'external-change' || drainsAfterPanelDispose(entry.message),
      onError: (error) => {
        void vscode.window.showErrorMessage(
          error instanceof Error
            ? error.message
            : `DocBlocks could not update ${getDisplayBasename(this.uri)}`,
        );
      },
    });
    this.latestEditQueue = new LatestDocumentEditQueue({
      apply: (message) => this.applyWebviewEdit(message),
      onError: (error) => {
        void vscode.window.showErrorMessage(
          error instanceof Error
            ? error.message
            : `DocBlocks could not accept an edit for ${getDisplayBasename(this.uri)}`,
        );
      },
    });
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBarItem.name = 'DocBlocks document status';
    this.disposables.push(this.statusBarItem);
    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: getEditorLocalResourceRoots(this.context.extensionUri),
    };
    this.panel.iconPath = vscode.Uri.joinPath(
      this.context.extensionUri,
      'resources',
      'docblocks-icon.svg',
    );
    this.panel.webview.html = getEditorHtml(this.panel.webview, this.context.extensionUri);
    this.updateTitle();
    this.updateStatusBar();
    this.syncReady = this.initializeSync();
    this.registerEventHandlers();
  }

  public static async open(context: vscode.ExtensionContext, uri: vscode.Uri): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri);
    await MarkdownEditorPanel.openDocument(context, document);
  }

  /**
   * Open the standalone editor for a document VS Code has already resolved.
   *
   * This path is reserved for explicit DocBlocks commands. The default custom
   * editor route attaches directly to VS Code's resource-backed panel through
   * {@link attachCustomEditor}.
   */
  public static openDocument(
    context: vscode.ExtensionContext,
    document: vscode.TextDocument,
    viewColumn: vscode.ViewColumn = vscode.ViewColumn.Active,
  ): Promise<void> {
    const uri = document.uri;
    const key = uri.toString();
    const existingPanel = MarkdownEditorPanel.panels.get(key);
    if (existingPanel) {
      existingPanel.panel.reveal(viewColumn);
      return Promise.resolve();
    }

    const panel = vscode.window.createWebviewPanel(
      MarkdownEditorPanel.viewType,
      getDisplayBasename(uri),
      viewColumn,
      {
        enableScripts: true,
        localResourceRoots: getEditorLocalResourceRoots(context.extensionUri),
        retainContextWhenHidden: true,
      },
    );

    return MarkdownEditorPanel.attachPanel(context, document, panel);
  }

  /** Bind DocBlocks directly to the resource-backed panel owned by VS Code. */
  public static attachCustomEditor(
    context: vscode.ExtensionContext,
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    return MarkdownEditorPanel.attachPanel(context, document, panel);
  }

  private static attachPanel(
    context: vscode.ExtensionContext,
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    const key = document.uri.toString();
    const existingPanel = MarkdownEditorPanel.panels.get(key);
    if (existingPanel) {
      // Opening a document DocBlocks already owns must reveal the live editor,
      // not fail. The custom-editor route surfaces a rejected resolve as an
      // error toast on a broken tab, so throwing here turned "click the file I
      // already have open" into an error. The caller has handed us a duplicate
      // panel for a document that only supports one editor, so dispose it —
      // that closes the duplicate tab — and then reveal the real one last so it
      // wins focus.
      if (existingPanel.panel !== panel) {
        panel.dispose();
        existingPanel.panel.reveal();
      }
      return Promise.resolve();
    }
    const editorPanel = new MarkdownEditorPanel(context, document.uri, document, panel);
    MarkdownEditorPanel.panels.set(key, editorPanel);
    return editorPanel.syncReady.then(
      () => undefined,
      (error: unknown) => {
        if (MarkdownEditorPanel.panels.get(key) === editorPanel) {
          MarkdownEditorPanel.panels.delete(key);
        }
        panel.dispose();
        throw error;
      },
    );
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

  public static async handleDocumentStatusAction(uriValue: unknown): Promise<void> {
    if (typeof uriValue !== 'string') return;
    await MarkdownEditorPanel.panels.get(uriValue)?.handleDocumentStatusAction();
  }

  private async initializeSync(): Promise<VscodeDocumentSync> {
    const adapter: HostDocumentAdapter = {
      key: this.uri.toString(),
      read: () => this.readHostDocument(),
      replaceAndSave: (content, expected) => this.replaceAndSaveHostDocument(content, expected),
    };
    const settings = readVscodeEditorSettings(this.uri);
    const sync = await VscodeDocumentSync.create(adapter, {
      autoSaveEnabled: settings.autoSave,
      readSaveParticipantPolicy: () => this.readSaveParticipantPolicy(),
    });
    this.sync = sync;
    this.unsubscribeSync = sync.subscribe(() => {
      this.sendSessionState();
      this.updateTitle();
      this.updateStatusBar();
    });
    this.updateTitle();
    this.updateStatusBar();
    return sync;
  }

  private registerEventHandlers(): void {
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((value: unknown) => {
        const message = parseWebviewToExtensionMessage(value);
        if (!message) {
          this.warnInvalidMessageOnce();
          return;
        }
        if (message.type === 'edit') {
          this.latestEditQueue.enqueue(message);
          return;
        }
        if (
          !this.messageQueue.enqueue({ kind: 'webview', message }, () =>
            this.handleMessage(message),
          )
        ) {
          this.rejectBusyMessage(message);
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.toString() !== this.uri.toString() || this.isApplyingEdit) return;
        this.document = event.document;
        this.updateTitle();
        this.updateStatusBar();
        // VS Code also emits this event for dirty-state and other bookkeeping
        // transitions. Those carry no text edits and must not be presented as
        // a competing document branch.
        if (event.contentChanges.length === 0) return;
        this.queueExternalChange();
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri.toString() !== this.uri.toString()) return;
        this.document = document;
        this.updateTitle();
        this.updateStatusBar();
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (document.uri.toString() !== this.uri.toString()) return;
        this.updateTitle();
        this.updateStatusBar();
      }),
      this.panel.onDidChangeViewState(() => {
        this.updateStatusBar();
      }),
      vscode.window.onDidChangeActiveColorTheme(() => {
        this.sendTheme();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          !event.affectsConfiguration('docblocks.autoSave', this.uri) &&
          !event.affectsConfiguration('docblocks.accentColor', this.uri) &&
          !event.affectsConfiguration('docblocks.writeCanvasTextSize', this.uri) &&
          !event.affectsConfiguration('docblocks.writeCanvasLineSpacing', this.uri)
        ) {
          return;
        }
        void this.applyEditorSettings().catch((error: unknown) => {
          void vscode.window.showErrorMessage(
            `DocBlocks could not apply its editor settings: ${toError(error).message}`,
          );
        });
      }),
      this.panel.onDidDispose(() => {
        this.panelDisposed = true;
        this.messageQueue.beginDispose();
        this.latestEditQueue.beginDispose();
        MarkdownEditorPanel.panels.delete(this.uri.toString());
        MarkdownEditorPanel.exportGrants.revokeScope(this.exportGrantScope);
        vscode.Disposable.from(...this.disposables).dispose();
        this.trackClose();
      }),
    );
  }

  /**
   * Collapse external document changes onto a single queue slot.
   *
   * Only the current VS Code buffer describes the external branch. Enqueuing
   * one entry per event therefore bought nothing and cost correctness: this
   * queue is bounded at
   * {@link MAX_PENDING_OPERATIONS} and is shared with webview requests that
   * await a modal dialog *inside* the queued operation (pickExportTarget and
   * saveExport both await showSaveDialog). While such an operation stalls the
   * tail nothing drains, so a burst — an agent or formatter rewriting the file,
   * or someone typing in a side-by-side text editor — overflowed the bound and
   * was dropped newest-first, pinning the webview to a stale snapshot with no
   * conflict indication until the next commit re-read.
   *
   * Coalescing keeps the ordering guarantee (the entry still runs in queue
   * order relative to webview messages) while making that overflow structurally
   * unreachable: at most one external-change entry is ever pending. The queued
   * operation re-reads the live TextDocument after pending webview edits drain,
   * so an obsolete intermediate event cannot create a stale conflict prompt.
   */
  private queueExternalChange(): void {
    this.externalChangePending = true;
    if (this.externalChangeQueued) return;
    this.externalChangeQueued = true;

    const accepted = this.messageQueue.enqueue({ kind: 'external-change' }, async () => {
      this.externalChangeQueued = false;
      if (!this.externalChangePending) return;
      this.externalChangePending = false;
      await this.applyExternalChange();
    });
    if (accepted) return;

    // The queue refuses work while disposing (the close-time flush re-reads the
    // document, so nothing is lost) or while saturated by webview requests.
    // Keep the observation and retry once the tail drains rather than dropping it.
    this.externalChangeQueued = false;
    if (this.panelDisposed) return;
    void this.messageQueue.drain().then(() => {
      if (this.externalChangePending && !this.panelDisposed) this.queueExternalChange();
    });
  }

  private async applyExternalChange(): Promise<void> {
    await this.latestEditQueue.flush();
    const sync = await this.syncReady;
    // TextDocument instances are live. Confirm the current buffer here instead
    // of classifying content captured before this queued operation ran.
    const external = await this.readHostDocument();
    const wasConflicted = sync.getSnapshot().session.conflict !== null;
    const result = sync.observeExternal(external);
    if (result === 'applied') this.sendContent();
    if (result === 'conflict' && !wasConflicted) {
      void this.promptConflictResolution(sync, false);
    }
    this.sendSessionState();
    this.updateTitle();
  }

  private async handleMessage(message: QueuedWebviewMessage): Promise<void> {
    switch (message.type) {
      case 'resolveMedia':
      case 'listMedia':
      case 'addMedia':
      case 'removeMedia':
        await handleMediaMessage(message, await this.ensureDocument(), this.panel.webview);
        return;

      case 'saveExport':
      case 'resolveExportTarget':
      case 'pickExportTarget':
      case 'readWorkspaceFile':
        await handleExportMessage(
          message,
          await this.ensureDocument(),
          this.panel.webview,
          this.context,
          {
            grants: MarkdownEditorPanel.exportGrants,
            scope: this.exportGrantScope,
          },
        );
        return;

      case 'ready':
        await this.syncReady;
        this.webviewReady = true;
        this.sendContent();
        this.sendSessionState();
        this.sendTheme();
        this.sendEditorSettings();
        break;

      case 'setAutoSave':
      case 'setAccentColor':
      case 'setWriteCanvasSettings':
        await this.handleSettingsUpdate(message);
        break;

      case 'openLink':
        await this.handleOpenLink(message.href);
        break;

      case 'save':
        await this.handleSave(message, await this.syncReady);
        break;

      case 'resolveConflict':
        await this.handleConflictChoice(message.sessionId, message.choice, await this.syncReady);
        break;

      default:
        assertNever(message);
    }
  }

  private async handleSave(
    message: Extract<WebviewToExtensionMessage, { type: 'save' }>,
    sync: VscodeDocumentSync,
  ): Promise<void> {
    try {
      await this.latestEditQueue.flush();
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
      const messageText = boundedMessage(toError(error).message);
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
    await this.latestEditQueue.flush();
    if (sessionId !== sync.getSnapshot().sessionId) {
      this.sendContent();
      return;
    }

    try {
      await sync.resolveConflict(choice);
      // Reload after a content replacement, or when a byte-identical latest
      // host snapshot automatically rotated the client version while the
      // conflict controls were open.
      if (choice === 'use-external' || sessionId !== sync.getSnapshot().sessionId) {
        this.sendContent();
      }
      this.sendSessionState();
    } catch (error: unknown) {
      await vscode.window.showErrorMessage(toError(error).message);
    }
  }

  private promptConflictResolution(sync: VscodeDocumentSync, modal: boolean): Promise<void> {
    if (this.conflictPrompt) return this.conflictPrompt;
    const prompt = this.runConflictResolutionPrompt(sync, modal).finally(() => {
      if (this.conflictPrompt === prompt) this.conflictPrompt = null;
    });
    this.conflictPrompt = prompt;
    return prompt;
  }

  private async runConflictResolutionPrompt(
    sync: VscodeDocumentSync,
    modal: boolean,
  ): Promise<void> {
    const snapshot = sync.getSnapshot();
    if (!snapshot.session.conflict) return;

    const fileName = getDisplayBasename(this.uri);
    const message = `${fileName}'s VS Code buffer changed outside this DocBlocks editor while local edits were pending.`;
    const choice = modal
      ? await vscode.window.showWarningMessage(
          message,
          {
            modal: true,
            detail: formatConflictResolutionDetail(snapshot.conflict),
          },
          KEEP_LOCAL_CHOICE,
          USE_EXTERNAL_CHOICE,
        )
      : await vscode.window.showWarningMessage(message, KEEP_LOCAL_CHOICE, USE_EXTERNAL_CHOICE);

    if (this.panelDisposed || !choice) return;
    await this.handleConflictChoice(
      snapshot.sessionId,
      choice === KEEP_LOCAL_CHOICE ? 'use-local' : 'use-external',
      sync,
    );
  }

  private async handleDocumentStatusAction(): Promise<void> {
    const sync = await this.syncReady;
    const status = sync.getSnapshot().session.status;
    if (status === 'conflict') {
      await this.promptConflictResolution(sync, true);
      return;
    }
    if (status !== 'dirty' && status !== 'error') return;

    try {
      await this.latestEditQueue.flush();
      const snapshot = sync.getSnapshot();
      if (snapshot.session.status === 'conflict') {
        await this.promptConflictResolution(sync, true);
        return;
      }
      if (snapshot.session.status !== 'dirty' && snapshot.session.status !== 'error') return;
      await sync.save({
        sessionId: snapshot.sessionId,
        clientRevision: snapshot.acknowledgedClientRevision,
        baseDocumentVersion: snapshot.baseDocumentVersion,
      });
    } catch (error: unknown) {
      await vscode.window.showErrorMessage(
        `DocBlocks could not save ${getDisplayBasename(this.uri)}: ${toError(error).message}`,
      );
    }
  }

  private async handleSettingsUpdate(
    message: Extract<
      WebviewToExtensionMessage,
      { type: 'setAutoSave' | 'setAccentColor' | 'setWriteCanvasSettings' }
    >,
  ): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('docblocks', this.uri);
    const updates: ReadonlyArray<[VscodeEditorConfigurationKey, boolean | string | number]> =
      message.type === 'setAutoSave'
        ? [['autoSave', message.enabled]]
        : message.type === 'setAccentColor'
          ? [['accentColor', message.accentColor]]
          : [
              ['writeCanvasTextSize', message.settings.textSize],
              ['writeCanvasLineSpacing', message.settings.lineSpacing],
            ];
    try {
      for (const [key, value] of updates) {
        await configuration.update(key, value, getConfigurationTarget(configuration, key));
      }
    } catch (error: unknown) {
      await vscode.window.showErrorMessage(
        `DocBlocks could not update its editor settings: ${toError(error).message}`,
      );
    }
    await this.applyEditorSettings();
  }

  private async handleOpenLink(href: string): Promise<void> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(this.uri);
    const documentWorkspacePath = workspaceFolder
      ? vscode.workspace.asRelativePath(this.uri, false)
      : null;
    const target = resolveEditorLinkTarget(href, documentWorkspacePath);

    if (!target) {
      await vscode.window.showWarningMessage(
        'DocBlocks only opens HTTP(S) links or files inside the current workspace.',
      );
      return;
    }

    try {
      if (target.kind === 'external') {
        const opened = await vscode.env.openExternal(vscode.Uri.parse(target.url, true));
        if (!opened) throw new Error('VS Code did not open the external link.');
        return;
      }

      if (!workspaceFolder) {
        throw new Error('The linked file is not inside an open workspace.');
      }
      const targetUri = vscode.Uri.joinPath(workspaceFolder.uri, ...target.path.split('/'));
      await vscode.commands.executeCommand('vscode.open', targetUri, { preview: false });
    } catch (error: unknown) {
      await vscode.window.showErrorMessage(
        boundedMessage(`DocBlocks could not open the link: ${toError(error).message}`),
      );
    }
  }

  private async applyEditorSettings(): Promise<void> {
    const settings = readVscodeEditorSettings(this.uri);
    const sync = await this.syncReady;
    sync.setAutoSaveEnabled(settings.autoSave);
    this.sendEditorSettings(settings);
  }

  private warnInvalidMessageOnce(): void {
    if (this.invalidMessageWarningShown) return;
    this.invalidMessageWarningShown = true;
    void vscode.window.showWarningMessage('DocBlocks ignored an invalid editor message.');
  }

  private rejectBusyMessage(message: QueuedWebviewMessage): void {
    if (message.type === 'openLink') {
      void vscode.window.showWarningMessage(
        'DocBlocks could not open the link because the editor queue is full.',
      );
      return;
    }
    if (!('requestId' in message)) return;
    const responseMessage = 'DocBlocks rejected the request because the editor queue is full.';
    switch (message.type) {
      case 'resolveMedia':
      case 'listMedia':
      case 'addMedia':
      case 'removeMedia':
        this.postMessage({
          type: 'mediaError',
          requestId: message.requestId,
          message: responseMessage,
        });
        return;
      case 'readWorkspaceFile':
        this.postMessage({
          type: 'workspaceFileError',
          requestId: message.requestId,
          message: responseMessage,
        });
        return;
      case 'saveExport':
      case 'resolveExportTarget':
      case 'pickExportTarget':
        this.postMessage({
          type: 'exportError',
          requestId: message.requestId,
          message: responseMessage,
        });
        return;
      case 'save':
        this.sendSessionState();
        return;
      default:
        return;
    }
  }

  private async readHostDocument(): Promise<HostDocumentSnapshot> {
    const document = await this.ensureDocument();
    return toHostSnapshot(document);
  }

  /**
   * Resolve which of VS Code's built-in save participants will rewrite this
   * document's text on save. Scoping by the TextDocument (not just the URI)
   * resolves language-specific overrides such as `"[markdown]"` the same way
   * VS Code's own participants do.
   */
  private readSaveParticipantPolicy(): SaveParticipantPolicy {
    const files = vscode.workspace.getConfiguration('files', this.document);
    return { trimTrailingWhitespace: files.get<unknown>('trimTrailingWhitespace') === true };
  }

  private async applyWebviewEdit(message: WebviewEditMessage): Promise<void> {
    const sync = await this.syncReady;
    const acknowledgement = sync.acceptEdit(message);
    this.postMessage({
      type: 'editAcknowledged',
      sessionId: message.sessionId,
      clientRevision: acknowledgement.clientRevision,
      sessionRevision: acknowledgement.sessionRevision,
      accepted: acknowledgement.accepted,
      message: acknowledgement.message,
    });
    if (!acknowledgement.accepted) {
      void vscode.window.showErrorMessage(
        acknowledgement.message ?? `VS Code rejected an edit for ${getDisplayBasename(this.uri)}.`,
      );
      this.sendContent();
      this.sendSessionState();
    }
  }

  private async replaceAndSaveHostDocument(
    content: string,
    expected: HostDocumentSnapshot,
  ): Promise<HostDocumentSnapshot> {
    let document = await this.ensureDocument();
    const immediatelyBeforeApply = toHostSnapshot(document);
    if (
      immediatelyBeforeApply.version !== expected.version ||
      immediatelyBeforeApply.content !== expected.content
    ) {
      throw new HostDocumentChangedError(
        immediatelyBeforeApply,
        'The VS Code document changed immediately before the DocBlocks edit was applied.',
      );
    }
    // Keep ownership through save participants as well as applyEdit. VS Code
    // can emit document-change events while document.save() runs (formatting,
    // final-newline normalization, and similar participants); those are part
    // of this commit, so their change events must not be misread as external
    // edits. Because they are suppressed here, the commit target's post-save
    // comparison is the only external-change detector for this window: it
    // forgives exactly the participant transformations this document is
    // configured for (see readSaveParticipantPolicy) and conflicts on the rest.
    await withApplyingEditFlag(
      (nextIsApplyingEdit) => {
        this.isApplyingEdit = nextIsApplyingEdit;
      },
      async () => {
        if (document.getText() !== content) {
          const edit = new vscode.WorkspaceEdit();
          edit.replace(document.uri, getFullDocumentRange(document), content);

          // VS Code's public WorkspaceEdit API has no compare-and-swap/version
          // precondition. This is the latest possible deterministic recheck,
          // but an external edit can still land inside applyEdit itself. The
          // final snapshot verification below detects that bounded race.
          const didApply = await vscode.workspace.applyEdit(edit);
          if (!didApply) {
            throw new Error(
              `VS Code rejected the DocBlocks edit for ${getDisplayBasename(this.uri)}`,
            );
          }
          document = await this.ensureDocument();
        }

        if (document.isDirty) {
          const didSave = await document.save();
          if (!didSave) {
            throw new Error(`VS Code could not save ${getDisplayBasename(this.uri)}`);
          }
          document = await this.ensureDocument();
        }
      },
    );

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
      fileName: getDisplayBasename(this.uri),
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
      error: snapshot.session.error ? boundedMessage(snapshot.session.error.message) : null,
      conflict: snapshot.conflict,
    });
  }

  private sendTheme(): void {
    if (!this.webviewReady) return;
    this.postMessage({
      type: 'themeChange',
      theme: getVscodeTheme(),
    });
  }

  private sendEditorSettings(settings = readVscodeEditorSettings(this.uri)): void {
    if (!this.webviewReady) return;
    this.postMessage({ type: 'editorSettings', settings });
  }

  private postMessage(message: ExtensionToWebviewMessage): void {
    if (this.panelDisposed) return;
    void this.panel.webview.postMessage(message);
  }

  private updateTitle(): void {
    // ExtHostWebviewPanel asserts on the title setter once VS Code disposes
    // the panel. The close-time flush keeps mutating session state after
    // onDidDispose (prepareClose emits synchronously, and the commit path
    // calls updateTitle directly), so every panel-scoped UI write has to be
    // gated the same way postMessage already is.
    if (this.panelDisposed) return;
    const status = this.sync?.getSnapshot().session.status;
    const unsaved =
      this.document.isDirty ||
      status === 'dirty' ||
      status === 'saving' ||
      status === 'error' ||
      status === 'conflict';
    this.panel.title = `${unsaved ? '* ' : ''}${getDisplayBasename(this.uri)}`;
  }

  private updateStatusBar(): void {
    // `panel.active` asserts after dispose, and onDidDispose has already
    // disposed statusBarItem through `this.disposables`, so there is no
    // surviving surface to update once the panel is gone.
    if (this.panelDisposed) return;
    const session = this.sync?.getSnapshot().session;
    if (!this.panel.active || !session) {
      this.statusBarItem.hide();
      return;
    }

    const presentation = getDocumentStatusBarPresentation(
      session.status,
      getDisplayBasename(this.uri),
      session.error ? boundedMessage(session.error.message) : null,
    );
    if (!presentation) {
      this.statusBarItem.hide();
      return;
    }

    this.statusBarItem.text = presentation.text;
    this.statusBarItem.tooltip = presentation.tooltip;
    this.statusBarItem.color = undefined;
    this.statusBarItem.backgroundColor =
      presentation.severity === 'error'
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : presentation.severity === 'warning'
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
    this.statusBarItem.accessibilityInformation = {
      label: presentation.accessibilityLabel,
    };
    this.statusBarItem.command = presentation.action
      ? {
          command: MarkdownEditorPanel.documentStatusCommand,
          title:
            presentation.action === 'save'
              ? 'Save DocBlocks document'
              : 'Resolve DocBlocks document conflict',
          arguments: [this.uri.toString()],
        }
      : undefined;
    this.statusBarItem.show();
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
      await this.messageQueue.drain();
      await this.latestEditQueue.flush();
      const sync = await this.syncReady;
      try {
        await sync.prepareClose();
      } catch (error: unknown) {
        if (sync.getSnapshot().session.status !== 'conflict') throw error;
        const choice = await vscode.window.showWarningMessage(
          `${getDisplayBasename(this.uri)}'s VS Code buffer changed outside this DocBlocks editor. Choose which version to keep before the editor closes.`,
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
        `DocBlocks could not finish saving ${getDisplayBasename(this.uri)}: ${toError(error).message}`,
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
      `The unsaved DocBlocks draft for ${getDisplayBasename(this.uri)} was preserved in a new untitled editor.`,
    );
  }
}

function readVscodeEditorSettings(uri: vscode.Uri): VscodeEditorSettings {
  const configuration = vscode.workspace.getConfiguration('docblocks', uri);
  const autoSave = configuration.get<unknown>('autoSave');
  const accentColor = configuration.get<unknown>('accentColor');
  const textSize = configuration.get<unknown>('writeCanvasTextSize');
  const lineSpacing = configuration.get<unknown>('writeCanvasLineSpacing');
  return {
    autoSave: typeof autoSave === 'boolean' ? autoSave : true,
    accentColor: isDocBlocksAccentColor(accentColor) ? accentColor : 'brown',
    writeCanvasSettings: {
      textSize: isDocBlocksWriteCanvasTextSize(textSize)
        ? textSize
        : DEFAULT_VSCODE_WRITE_CANVAS_SETTINGS.textSize,
      lineSpacing: isDocBlocksWriteCanvasLineSpacing(lineSpacing)
        ? lineSpacing
        : DEFAULT_VSCODE_WRITE_CANVAS_SETTINGS.lineSpacing,
    },
  };
}

type VscodeEditorConfigurationKey =
  | 'autoSave'
  | 'accentColor'
  | 'writeCanvasTextSize'
  | 'writeCanvasLineSpacing';

function getConfigurationTarget(
  configuration: vscode.WorkspaceConfiguration,
  key: VscodeEditorConfigurationKey,
): vscode.ConfigurationTarget {
  const inspected = configuration.inspect<unknown>(key);
  if (inspected?.workspaceFolderValue !== undefined) {
    return vscode.ConfigurationTarget.WorkspaceFolder;
  }
  if (inspected?.workspaceValue !== undefined) return vscode.ConfigurationTarget.Workspace;
  return vscode.ConfigurationTarget.Global;
}

function getFullDocumentRange(document: vscode.TextDocument): vscode.Range {
  const contentLength = document.getText().length;
  return new vscode.Range(document.positionAt(0), document.positionAt(contentLength));
}

function toHostSnapshot(document: vscode.TextDocument): HostDocumentSnapshot {
  const content = document.getText();
  if (content.length > HOST_WIRE_LIMITS.documentCharacters) {
    throw new Error('This document exceeds the DocBlocks editor size limit.');
  }
  return {
    content,
    version: document.version,
    observedAt: Date.now(),
    isDirty: document.isDirty,
  };
}

/**
 * A document's name, bounded for use as a label.
 *
 * Truncation belongs here at the UI edge and nowhere deeper: the shared
 * {@link getUriBasename} is lossless because the media path authority derives
 * `<document>_files` from it (see its contract). Panel titles, toasts, and the
 * status bar only need something a human reads, so they cap the length; a name
 * this long is already unreadable in a tab.
 */
function getDisplayBasename(uri: vscode.Uri): string {
  return getUriBasename(uri).slice(0, 255);
}

function boundedMessage(message: string): string {
  return message.slice(0, HOST_WIRE_LIMITS.messageCharacters);
}

function estimateWireCharacters(message: QueuedWebviewMessage): number {
  switch (message.type) {
    case 'addMedia':
    case 'saveExport':
      return message.dataBase64.length;
    default:
      return 0;
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled editor message: ${String(value)}`);
}
