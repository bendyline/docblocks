import { createRequire } from 'node:module';

/**
 * A minimal in-memory stand-in for the `vscode` module.
 *
 * The extension host is the only place that can normally provide `vscode`, so
 * modules that import it (MarkdownEditorPanel above all) had no unit coverage
 * at all. This installs a fake module into Node's CommonJS loader before the
 * module under test is required, which lets the panel's real lifecycle run in
 * process.
 *
 * The fakes deliberately reproduce the parts of the real extension-host
 * semantics the tests depend on:
 * - `ExtHostWebviewPanel` asserts on `title`/`active`/`iconPath`/`viewColumn`
 *   once disposed, while `postMessage` merely resolves `false`.
 * - `TextDocument.save()` runs save participants, which may rewrite the buffer
 *   and bump `version` before the save resolves.
 */

export type Listener<T> = (event: T) => void;

export interface StubDisposable {
  dispose(): void;
}

export class FakeEmitter<T> {
  private readonly listeners = new Set<Listener<T>>();

  public readonly event = (listener: Listener<T>): StubDisposable => {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  };

  public fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }

  public get listenerCount(): number {
    return this.listeners.size;
  }
}

export class FakeUri {
  public constructor(
    public readonly path: string,
    private readonly serialized?: string,
  ) {}

  public static file(path: string): FakeUri {
    return new FakeUri(path);
  }

  public static parse(value: string): FakeUri {
    const url = new URL(value);
    return new FakeUri(url.pathname, url.href);
  }

  public static joinPath(base: FakeUri, ...segments: string[]): FakeUri {
    return new FakeUri([base.path, ...segments].join('/'));
  }

  public get scheme(): string {
    return this.serialized?.slice(0, this.serialized.indexOf(':')) ?? 'file';
  }

  public get fsPath(): string {
    return this.path;
  }

  public toString(): string {
    return this.serialized ?? `file://${this.path}`;
  }
}

/** A save participant: maps the buffer text to its post-save text. */
export type SaveParticipant = (text: string) => string;

export class FakeTextDocument {
  public version = 1;
  public isDirty = false;
  public languageId = 'markdown';
  /** Text last persisted by save(); the tests assert on this, not the buffer. */
  public savedText: string;
  /** Stands in for VS Code's built-in save participants (trim, format, ...). */
  public saveParticipant: SaveParticipant = (text) => text;
  public saveCount = 0;

  private text: string;

  public constructor(
    public readonly uri: FakeUri,
    text: string,
  ) {
    this.text = text;
    this.savedText = text;
  }

  public getText(): string {
    return this.text;
  }

  public positionAt(offset: number): { offset: number } {
    return { offset };
  }

  public save(): Promise<boolean> {
    this.saveCount += 1;
    const participated = this.saveParticipant(this.text);
    if (participated !== this.text) {
      this.text = participated;
      this.version += 1;
    }
    this.isDirty = false;
    this.savedText = this.text;
    return Promise.resolve(true);
  }

  /** Simulate any write to the buffer (our WorkspaceEdit, or another editor). */
  public setText(text: string): void {
    if (text === this.text) return;
    this.text = text;
    this.version += 1;
    this.isDirty = true;
  }
}

export class FakeWebviewPanel {
  public disposed = false;
  public revealCount = 0;
  public readonly posted: unknown[] = [];
  public readonly onDidDisposeEmitter = new FakeEmitter<void>();
  public readonly onDidChangeViewStateEmitter = new FakeEmitter<void>();
  public readonly onDidReceiveMessageEmitter = new FakeEmitter<unknown>();

  public readonly webview = {
    options: {} as unknown,
    html: '',
    cspSource: 'vscode-webview://stub',
    asWebviewUri: (uri: FakeUri): FakeUri => uri,
    postMessage: (message: unknown): Promise<boolean> => {
      // Matches ExtHostWebview#postMessage: resolves false, never throws.
      if (this.disposed) return Promise.resolve(false);
      this.posted.push(message);
      return Promise.resolve(true);
    },
    onDidReceiveMessage: this.onDidReceiveMessageEmitter.event,
  };

  public readonly onDidDispose = this.onDidDisposeEmitter.event;
  public readonly onDidChangeViewState = this.onDidChangeViewStateEmitter.event;

  private titleValue = '';
  private iconPathValue: unknown = undefined;
  private activeValue = true;

  public get title(): string {
    this.assertNotDisposed();
    return this.titleValue;
  }

  public set title(value: string) {
    this.assertNotDisposed();
    this.titleValue = value;
  }

  public get iconPath(): unknown {
    this.assertNotDisposed();
    return this.iconPathValue;
  }

  public set iconPath(value: unknown) {
    this.assertNotDisposed();
    this.iconPathValue = value;
  }

  public get active(): boolean {
    this.assertNotDisposed();
    return this.activeValue;
  }

  public reveal(): void {
    this.assertNotDisposed();
    this.revealCount += 1;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.onDidDisposeEmitter.fire();
  }

  /** Read the title without tripping the disposal assert, for assertions. */
  public peekTitle(): string {
    return this.titleValue;
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error('Webview is disposed');
  }
}

export class FakeStatusBarItem {
  public text = '';
  public tooltip: unknown = undefined;
  public color: unknown = undefined;
  public backgroundColor: unknown = undefined;
  public accessibilityInformation: unknown = undefined;
  public command: unknown = undefined;
  public name: unknown = undefined;
  public visible = false;
  public disposed = false;

  public show(): void {
    this.visible = true;
  }

  public hide(): void {
    this.visible = false;
  }

  public dispose(): void {
    this.disposed = true;
  }
}

class FakeWorkspaceEdit {
  public readonly edits: { uri: FakeUri; content: string }[] = [];

  public replace(uri: FakeUri, _range: unknown, content: string): void {
    this.edits.push({ uri, content });
  }
}

class FakeFileSystemError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'FileSystemError';
  }

  public static FileNotFound(uri?: FakeUri): FakeFileSystemError {
    return new FakeFileSystemError(`File not found: ${uri?.toString() ?? ''}`, 'FileNotFound');
  }
}

export interface VscodeStub {
  documents: FakeTextDocument[];
  configuration: Map<string, unknown>;
  errorMessages: string[];
  warningMessages: string[];
  shownTextDocuments: FakeTextDocument[];
  untitledDocuments: FakeTextDocument[];
  workspaceFolders: { uri: FakeUri; name: string; index: number }[];
  workspaceFiles: Set<string>;
  externalUris: FakeUri[];
  clipboardWrites: string[];
  /** Reply used by showWarningMessage, e.g. a modal conflict choice. */
  warningResponse: string | undefined;
  onDidChangeTextDocumentEmitter: FakeEmitter<{
    document: FakeTextDocument;
    contentChanges: readonly unknown[];
    reason?: number;
  }>;
  onDidSaveTextDocumentEmitter: FakeEmitter<FakeTextDocument>;
  onDidCloseTextDocumentEmitter: FakeEmitter<FakeTextDocument>;
  onDidChangeConfigurationEmitter: FakeEmitter<unknown>;
  onDidChangeActiveColorThemeEmitter: FakeEmitter<unknown>;
  statusBarItems: FakeStatusBarItem[];
  /** Every panel handed out by window.createWebviewPanel, in creation order. */
  createdWebviewPanels: FakeWebviewPanel[];
  /** Every commands.executeCommand call, in order. */
  executedCommands: { command: string; args: unknown[] }[];
  /** Applied to the document buffer by workspace.applyEdit. */
  module: Record<string, unknown>;
}

interface CjsModule {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
}

let originalLoad: CjsModule['_load'] | null = null;
let installed: VscodeStub | null = null;

/**
 * Install the fake `vscode` module, or reset it if already installed.
 *
 * The module object must keep its identity for the lifetime of the process:
 * `require('vscode')` is cached by the modules under test, so state is reset in
 * place rather than by rebuilding the namespace.
 */
export function installVscodeStub(): VscodeStub {
  if (!installed) installed = createVscodeStub();
  resetVscodeStub(installed);
  if (!originalLoad) patchModuleLoader(installed);
  return installed;
}

function resetVscodeStub(stub: VscodeStub): void {
  stub.documents.length = 0;
  stub.configuration.clear();
  stub.errorMessages.length = 0;
  stub.warningMessages.length = 0;
  stub.shownTextDocuments.length = 0;
  stub.untitledDocuments.length = 0;
  stub.workspaceFolders.length = 0;
  stub.workspaceFiles.clear();
  stub.externalUris.length = 0;
  stub.clipboardWrites.length = 0;
  stub.statusBarItems.length = 0;
  stub.createdWebviewPanels.length = 0;
  stub.executedCommands.length = 0;
  stub.warningResponse = undefined;
}

function createVscodeStub(): VscodeStub {
  const stub: VscodeStub = {
    documents: [],
    configuration: new Map<string, unknown>(),
    errorMessages: [],
    warningMessages: [],
    shownTextDocuments: [],
    untitledDocuments: [],
    workspaceFolders: [],
    workspaceFiles: new Set(),
    externalUris: [],
    clipboardWrites: [],
    warningResponse: undefined,
    onDidChangeTextDocumentEmitter: new FakeEmitter(),
    onDidSaveTextDocumentEmitter: new FakeEmitter(),
    onDidCloseTextDocumentEmitter: new FakeEmitter(),
    onDidChangeConfigurationEmitter: new FakeEmitter(),
    onDidChangeActiveColorThemeEmitter: new FakeEmitter(),
    statusBarItems: [],
    createdWebviewPanels: [],
    executedCommands: [],
    module: {},
  };

  const findDocument = (uri: FakeUri): FakeTextDocument | undefined =>
    stub.documents.find((document) => document.uri.toString() === uri.toString());

  stub.module = {
    Uri: FakeUri,
    Range: class FakeRange {
      public constructor(
        public readonly start: unknown,
        public readonly end: unknown,
      ) {}
    },
    Position: class FakePosition {
      public constructor(
        public readonly line: number,
        public readonly character: number,
      ) {}
    },
    ThemeColor: class FakeThemeColor {
      public constructor(public readonly id: string) {}
    },
    WorkspaceEdit: FakeWorkspaceEdit,
    FileSystemError: FakeFileSystemError,
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    Disposable: class FakeDisposable {
      public constructor(private readonly callOnDispose?: () => void) {}

      public dispose(): void {
        this.callOnDispose?.();
      }

      public static from(...items: StubDisposable[]): FakeDisposable {
        return new FakeDisposable(() => {
          for (const item of items) item.dispose();
        });
      }
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { Active: -1, One: 1 },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    window: {
      activeColorTheme: { kind: 1 },
      activeTextEditor: undefined,
      createStatusBarItem: (): FakeStatusBarItem => {
        const item = new FakeStatusBarItem();
        stub.statusBarItems.push(item);
        return item;
      },
      createWebviewPanel: (): FakeWebviewPanel => {
        const panel = new FakeWebviewPanel();
        stub.createdWebviewPanels.push(panel);
        return panel;
      },
      showErrorMessage: (message: string): Promise<undefined> => {
        stub.errorMessages.push(message);
        return Promise.resolve(undefined);
      },
      showWarningMessage: (message: string): Promise<string | undefined> => {
        stub.warningMessages.push(message);
        return Promise.resolve(stub.warningResponse);
      },
      showTextDocument: (document: FakeTextDocument): Promise<unknown> => {
        stub.shownTextDocuments.push(document);
        return Promise.resolve({});
      },
      onDidChangeActiveColorTheme: stub.onDidChangeActiveColorThemeEmitter.event,
    },
    commands: {
      executeCommand: (command: string, ...args: unknown[]): Promise<undefined> => {
        stub.executedCommands.push({ command, args });
        return Promise.resolve(undefined);
      },
    },
    env: {
      openExternal: (uri: FakeUri): Promise<boolean> => {
        stub.externalUris.push(uri);
        return Promise.resolve(true);
      },
      clipboard: {
        writeText: (text: string): Promise<void> => {
          stub.clipboardWrites.push(text);
          return Promise.resolve();
        },
      },
    },
    workspace: {
      fs: {
        stat: (
          target: FakeUri,
        ): Promise<{ type: number; ctime: number; mtime: number; size: number }> => {
          if (stub.workspaceFiles.has(target.path) || findDocument(target)) {
            return Promise.resolve({ type: 1, ctime: 0, mtime: 0, size: 0 });
          }
          return Promise.reject(FakeFileSystemError.FileNotFound(target));
        },
      },
      get workspaceFolders(): { uri: FakeUri; name: string; index: number }[] {
        return stub.workspaceFolders;
      },
      getWorkspaceFolder: (
        target: FakeUri,
      ): { uri: FakeUri; name: string; index: number } | undefined =>
        [...stub.workspaceFolders]
          .filter(
            (folder) =>
              folder.uri.scheme === target.scheme &&
              (target.path === folder.uri.path || target.path.startsWith(`${folder.uri.path}/`)),
          )
          .sort((left, right) => right.uri.path.length - left.uri.path.length)[0],
      asRelativePath: (target: FakeUri): string => {
        const folder = [...stub.workspaceFolders]
          .filter(
            (candidate) =>
              candidate.uri.scheme === target.scheme &&
              (target.path === candidate.uri.path ||
                target.path.startsWith(`${candidate.uri.path}/`)),
          )
          .sort((left, right) => right.uri.path.length - left.uri.path.length)[0];
        return folder ? target.path.slice(folder.uri.path.length).replace(/^\//, '') : target.path;
      },
      get textDocuments(): FakeTextDocument[] {
        return stub.documents;
      },
      openTextDocument: (target: FakeUri | { content: string }): Promise<FakeTextDocument> => {
        if (target instanceof FakeUri) {
          const existing = findDocument(target);
          if (existing) return Promise.resolve(existing);
          const created = new FakeTextDocument(target, '');
          stub.documents.push(created);
          return Promise.resolve(created);
        }
        const untitled = new FakeTextDocument(new FakeUri('/untitled'), target.content);
        stub.untitledDocuments.push(untitled);
        return Promise.resolve(untitled);
      },
      getConfiguration: (section: string) => ({
        get: (key: string): unknown => stub.configuration.get(`${section}.${key}`),
        update: (key: string, value: unknown): Promise<void> => {
          stub.configuration.set(`${section}.${key}`, value);
          return Promise.resolve();
        },
        inspect: (): undefined => undefined,
      }),
      applyEdit: (edit: FakeWorkspaceEdit): Promise<boolean> => {
        for (const entry of edit.edits) {
          const document = findDocument(entry.uri);
          if (!document) return Promise.resolve(false);
          document.setText(entry.content);
          stub.onDidChangeTextDocumentEmitter.fire({
            document,
            contentChanges: [{ text: entry.content }],
          });
        }
        return Promise.resolve(true);
      },
      onDidChangeTextDocument: stub.onDidChangeTextDocumentEmitter.event,
      onDidSaveTextDocument: stub.onDidSaveTextDocumentEmitter.event,
      onDidCloseTextDocument: stub.onDidCloseTextDocumentEmitter.event,
      onDidChangeConfiguration: stub.onDidChangeConfigurationEmitter.event,
    },
  };

  return stub;
}

function patchModuleLoader(stub: VscodeStub): void {
  const require = createRequire(__filename);
  const cjs = require('node:module') as CjsModule;
  const previous = cjs._load;
  originalLoad = previous;
  cjs._load = function patchedLoad(
    this: unknown,
    request: string,
    parent: unknown,
    isMain: boolean,
  ): unknown {
    if (request === 'vscode') return stub.module;
    return previous.call(this, request, parent, isMain);
  };
}

/**
 * Restore the real loader. The stub namespace is intentionally kept alive: any
 * module that already required 'vscode' holds a reference to it, so a later
 * reinstall must hand back the same object rather than a fresh one those
 * modules would never see.
 */
export function uninstallVscodeStub(): void {
  if (!originalLoad) return;
  const require = createRequire(__filename);
  const cjs = require('node:module') as CjsModule;
  cjs._load = originalLoad;
  originalLoad = null;
}
