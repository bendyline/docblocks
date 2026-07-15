import * as vscode from 'vscode';
import { parseExternalHttpUrl } from '@bendyline/docblocks/host';
import {
  createCliInstallCommands,
  createVersionCheckInvocation,
  inspectMcpJson,
  inspectPackageJson,
  type PackageJsonInspection,
  type SetupVersionCommand,
  upsertDocBlocksMcpServer,
} from './setupEnvironment.js';
import { parseSetupWebviewMessage, type SetupWebviewMessage } from './setupMessages.js';
import { getNonce } from './webviewHelper.js';

interface CheckResult {
  id: string;
  status: 'checking' | 'passed' | 'failed';
  label: string;
  detail?: string;
  action?: 'installNode' | 'installCli' | 'configureMcp';
}

type WorkspacePackageState =
  | PackageJsonInspection
  | { kind: 'no-workspace' }
  | { kind: 'missing' }
  | { kind: 'unavailable'; detail: string };

type WorkspaceMcpState =
  | {
      kind: 'valid';
      configured: boolean;
      hasDocBlocksEntry: boolean;
      text: string;
    }
  | { kind: 'invalid'; detail: string }
  | { kind: 'no-workspace' }
  | { kind: 'missing' }
  | { kind: 'unavailable'; detail: string };

const NODE_DOWNLOAD_URL = 'https://nodejs.org/en/download/';
const ACTION_COOLDOWN_MS = 1_000;
const MAX_PACKAGE_JSON_BYTES = 256 * 1024;

export class SetupViewProvider {
  public static readonly viewType = 'docblocks.setupView';
  private static currentPanel: vscode.WebviewPanel | undefined;

  private checksInFlight: Promise<void> | null = null;
  private readonly lastActionAt = new Map<SetupWebviewMessage['type'], number>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  public static createOrShow(context: vscode.ExtensionContext): void {
    const column = vscode.window.activeTextEditor?.viewColumn;

    if (SetupViewProvider.currentPanel) {
      SetupViewProvider.currentPanel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      SetupViewProvider.viewType,
      'DocBlocks Setup',
      column ?? vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [],
        retainContextWhenHidden: true,
      },
    );

    SetupViewProvider.currentPanel = panel;
    panel.onDidDispose(() => {
      SetupViewProvider.currentPanel = undefined;
    });

    new SetupViewProvider(context).attach(panel.webview);
  }

  public attach(webview: vscode.Webview): void {
    webview.options = { enableScripts: true, localResourceRoots: [] };
    webview.html = this.getHtml(webview);

    const listener = webview.onDidReceiveMessage((value: unknown) => {
      const message = parseSetupWebviewMessage(value);
      if (!message) return;
      void this.handleMessage(message, webview).catch((error: unknown) => {
        const messageText = error instanceof Error ? error.message : String(error);
        return vscode.window.showErrorMessage(messageText);
      });
    });
    this.context.subscriptions.push(listener);
  }

  private async handleMessage(
    message: SetupWebviewMessage,
    webview: vscode.Webview,
  ): Promise<void> {
    switch (message.type) {
      case 'runChecks':
        await this.runChecks(webview);
        return;

      case 'openNodeDownload': {
        if (!this.acceptAction(message.type)) return;
        const url = parseExternalHttpUrl(NODE_DOWNLOAD_URL);
        if (!url) throw new Error('The configured Node.js URL is invalid');
        await vscode.env.openExternal(vscode.Uri.parse(url, true));
        return;
      }

      case 'installCli':
        if (!this.acceptAction(message.type) || !(await this.requireTrustedWorkspace())) return;
        await this.installCliInWorkspace();
        return;

      case 'configureMcp':
        if (!this.acceptAction(message.type) || !(await this.requireTrustedWorkspace())) return;
        await this.configureWorkspaceMcp();
        await this.runChecks(webview);
        return;

      default:
        assertNever(message);
    }
  }

  private runChecks(webview: vscode.Webview): Promise<void> {
    if (this.checksInFlight) return this.checksInFlight;
    const operation = this.performChecks(webview).finally(() => {
      if (this.checksInFlight === operation) this.checksInFlight = null;
    });
    this.checksInFlight = operation;
    return operation;
  }

  private async performChecks(webview: vscode.Webview): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const [nodeResult, npmResult, packageState, mcpState] = await Promise.all([
      this.checkVersion('node'),
      this.checkVersion('npm'),
      this.inspectWorkspacePackageJson(folder),
      this.inspectWorkspaceMcpJson(folder),
    ]);

    const checks: CheckResult[] = [
      {
        id: 'node',
        status: nodeResult ? 'passed' : 'failed',
        label: 'Node.js',
        detail: nodeResult ? `Installed: ${nodeResult.trim()}` : 'Not found',
        action: nodeResult ? undefined : 'installNode',
      },
      {
        id: 'npm',
        status: npmResult ? 'passed' : 'failed',
        label: 'npm',
        detail: npmResult ? `Installed: v${npmResult.trim()}` : 'Not found (comes with Node.js)',
        action: npmResult ? undefined : 'installNode',
      },
      this.createCliCheck(packageState, npmResult !== null),
      this.createMcpCheck(packageState, mcpState),
    ];

    for (const check of checks) {
      await webview.postMessage({ type: 'checkResult', check });
    }
    await webview.postMessage({ type: 'checksComplete' });
  }

  private async checkVersion(command: SetupVersionCommand): Promise<string | null> {
    try {
      const { execFile } = await import('child_process');
      const platform = typeof process === 'undefined' ? 'web' : process.platform;
      const isWin = platform === 'win32';
      const invocation = createVersionCheckInvocation(
        command,
        platform,
        typeof process === 'undefined' ? undefined : process.env.ComSpec,
      );
      const extraPaths = isWin ? '' : '/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/sbin';
      const currentPath = typeof process === 'undefined' ? '' : (process.env.PATH ?? '');
      const env =
        typeof process === 'undefined'
          ? undefined
          : {
              ...process.env,
              PATH: extraPaths ? `${extraPaths}:${currentPath}` : currentPath,
            };

      return await new Promise((resolve) => {
        execFile(
          invocation.executable,
          [...invocation.args],
          { timeout: 15_000, maxBuffer: 16 * 1024, windowsHide: true, env },
          (error, stdout) => resolve(error ? null : stdout.slice(0, 256)),
        );
      });
    } catch {
      // child_process is intentionally unavailable in vscode.dev.
      return null;
    }
  }

  private async installCliInWorkspace(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      await vscode.window.showWarningMessage(
        'Open a workspace folder before installing DocBlocks CLI as a dev dependency.',
      );
      return;
    }

    const packageState = await this.inspectWorkspacePackageJson(folder);
    if (packageState.kind === 'invalid' || packageState.kind === 'unavailable') {
      await vscode.window.showErrorMessage(packageState.detail);
      return;
    }
    if (packageState.kind === 'no-workspace') {
      await vscode.window.showWarningMessage(
        'Open a workspace folder before installing DocBlocks CLI as a dev dependency.',
      );
      return;
    }
    if (packageState.kind === 'valid' && packageState.cliDevDependency) {
      await vscode.window.showInformationMessage(
        'DocBlocks CLI is already listed in the workspace devDependencies.',
      );
      return;
    }

    if (!(await this.checkVersion('npm'))) {
      await vscode.window.showErrorMessage(
        'npm was not found. Install Node.js with npm, then re-check the environment.',
      );
      return;
    }

    this.runInTerminal(createCliInstallCommands(packageState.kind === 'valid'), folder.uri);
  }

  private async inspectWorkspacePackageJson(
    folder: vscode.WorkspaceFolder | undefined,
  ): Promise<WorkspacePackageState> {
    if (!folder) return { kind: 'no-workspace' };

    const uri = vscode.Uri.joinPath(folder.uri, 'package.json');
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if ((stat.type & vscode.FileType.File) === 0) {
        return { kind: 'invalid', detail: 'The workspace package.json is not a file.' };
      }
      if (stat.size > MAX_PACKAGE_JSON_BYTES) {
        return {
          kind: 'invalid',
          detail: 'The workspace package.json is too large for DocBlocks Setup to inspect.',
        };
      }

      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.byteLength > MAX_PACKAGE_JSON_BYTES) {
        return {
          kind: 'invalid',
          detail: 'The workspace package.json is too large for DocBlocks Setup to inspect.',
        };
      }

      try {
        return inspectPackageJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        return {
          kind: 'invalid',
          detail: 'The workspace package.json must be valid UTF-8.',
        };
      }
    } catch (error: unknown) {
      if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
        return { kind: 'missing' };
      }
      return {
        kind: 'unavailable',
        detail: 'DocBlocks Setup could not read the workspace package.json.',
      };
    }
  }

  private async configureWorkspaceMcp(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      await vscode.window.showWarningMessage(
        'Open a workspace folder before registering the DocBlocks MCP server.',
      );
      return;
    }

    const packageState = await this.inspectWorkspacePackageJson(folder);
    if (packageState.kind !== 'valid' || !packageState.cliDevDependency) {
      await vscode.window.showWarningMessage(
        'Install DocBlocks CLI as a workspace dev dependency before registering its MCP server.',
      );
      return;
    }

    const mcpUri = vscode.Uri.joinPath(folder.uri, '.vscode', 'mcp.json');
    const openDocument = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === mcpUri.toString(),
    );
    if (openDocument?.isDirty) {
      await vscode.window.showWarningMessage(
        'Save your changes to .vscode/mcp.json before DocBlocks Setup updates it.',
      );
      return;
    }

    const mcpState = await this.inspectWorkspaceMcpJson(folder);
    if (mcpState.kind === 'invalid' || mcpState.kind === 'unavailable') {
      await vscode.window.showErrorMessage(mcpState.detail);
      return;
    }
    if (mcpState.kind === 'no-workspace') return;
    if (mcpState.kind === 'valid' && mcpState.configured) {
      await vscode.window.showInformationMessage(
        'DocBlocks MCP is already registered in .vscode/mcp.json.',
      );
      return;
    }

    const updatedText = upsertDocBlocksMcpServer(mcpState.kind === 'valid' ? mcpState.text : null);
    const bytes = new TextEncoder().encode(updatedText);
    if (bytes.byteLength > MAX_PACKAGE_JSON_BYTES) {
      await vscode.window.showErrorMessage(
        'The updated .vscode/mcp.json would be too large for DocBlocks Setup to write.',
      );
      return;
    }

    if (openDocument?.isDirty) {
      await vscode.window.showWarningMessage(
        'Save your changes to .vscode/mcp.json before DocBlocks Setup updates it.',
      );
      return;
    }
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, '.vscode'));
    await vscode.workspace.fs.writeFile(mcpUri, bytes);
    await vscode.window.showInformationMessage(
      'Registered DocBlocks MCP in the workspace .vscode/mcp.json.',
    );
  }

  private async inspectWorkspaceMcpJson(
    folder: vscode.WorkspaceFolder | undefined,
  ): Promise<WorkspaceMcpState> {
    if (!folder) return { kind: 'no-workspace' };

    const uri = vscode.Uri.joinPath(folder.uri, '.vscode', 'mcp.json');
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if ((stat.type & vscode.FileType.File) === 0) {
        return { kind: 'invalid', detail: 'The workspace .vscode/mcp.json is not a file.' };
      }
      if (stat.size > MAX_PACKAGE_JSON_BYTES) {
        return {
          kind: 'invalid',
          detail: 'The workspace .vscode/mcp.json is too large for DocBlocks Setup to inspect.',
        };
      }

      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.byteLength > MAX_PACKAGE_JSON_BYTES) {
        return {
          kind: 'invalid',
          detail: 'The workspace .vscode/mcp.json is too large for DocBlocks Setup to inspect.',
        };
      }

      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        return { kind: 'invalid', detail: 'The workspace .vscode/mcp.json must be valid UTF-8.' };
      }

      const inspection = inspectMcpJson(text);
      return inspection.kind === 'valid' ? { ...inspection, text } : inspection;
    } catch (error: unknown) {
      if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
        return { kind: 'missing' };
      }
      return {
        kind: 'unavailable',
        detail: 'DocBlocks Setup could not read the workspace .vscode/mcp.json.',
      };
    }
  }

  private createCliCheck(packageState: WorkspacePackageState, npmAvailable: boolean): CheckResult {
    const base = { id: 'cli', label: 'DocBlocks CLI' } as const;
    switch (packageState.kind) {
      case 'valid':
        return packageState.cliDevDependency
          ? {
              ...base,
              status: 'passed',
              detail: `Workspace dev dependency: ${packageState.cliDevDependency}`,
            }
          : {
              ...base,
              status: 'failed',
              detail: 'Not installed as a workspace dev dependency',
              action: npmAvailable ? 'installCli' : undefined,
            };
      case 'missing':
        return {
          ...base,
          status: 'failed',
          detail: 'Not installed; setup will create package.json in the workspace root',
          action: npmAvailable ? 'installCli' : undefined,
        };
      case 'no-workspace':
        return {
          ...base,
          status: 'failed',
          detail: 'Open a workspace folder to install it as a dev dependency',
        };
      case 'invalid':
      case 'unavailable':
        return { ...base, status: 'failed', detail: packageState.detail };
      default:
        return assertNever(packageState);
    }
  }

  private createMcpCheck(
    packageState: WorkspacePackageState,
    mcpState: WorkspaceMcpState,
  ): CheckResult {
    const base = { id: 'mcp', label: 'VS Code MCP' } as const;
    if (packageState.kind !== 'valid' || !packageState.cliDevDependency) {
      return {
        ...base,
        status: 'failed',
        detail: 'Complete the DocBlocks CLI step before registering the MCP server',
      };
    }

    switch (mcpState.kind) {
      case 'valid':
        return mcpState.configured
          ? {
              ...base,
              status: 'passed',
              detail: 'Registered in .vscode/mcp.json with the workspace CLI',
            }
          : {
              ...base,
              status: 'failed',
              detail: mcpState.hasDocBlocksEntry
                ? 'The existing docblocks server does not use the workspace CLI'
                : 'Not registered in .vscode/mcp.json',
              action: 'configureMcp',
            };
      case 'missing':
        return {
          ...base,
          status: 'failed',
          detail: 'Not registered; setup will create .vscode/mcp.json',
          action: 'configureMcp',
        };
      case 'no-workspace':
        return { ...base, status: 'failed', detail: 'Open a workspace folder first' };
      case 'invalid':
      case 'unavailable':
        return { ...base, status: 'failed', detail: mcpState.detail };
      default:
        return assertNever(mcpState);
    }
  }

  private acceptAction(action: SetupWebviewMessage['type']): boolean {
    const now = Date.now();
    const previous = this.lastActionAt.get(action) ?? 0;
    if (now - previous < ACTION_COOLDOWN_MS) return false;
    this.lastActionAt.set(action, now);
    return true;
  }

  private async requireTrustedWorkspace(): Promise<boolean> {
    if (vscode.workspace.isTrusted) return true;
    await vscode.window.showWarningMessage(
      'Trust this workspace before DocBlocks runs setup commands in a terminal.',
    );
    return false;
  }

  private runInTerminal(command: string | readonly string[], cwd?: string | vscode.Uri): void {
    const terminal = vscode.window.createTerminal({ name: 'DocBlocks Setup', cwd });
    for (const line of typeof command === 'string' ? [command] : command) {
      terminal.sendText(line);
    }
    terminal.show();
  }

  private getHtml(_webview: vscode.Webview): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      padding: 12px;
      margin: 0;
    }
    h2 { font-size: 14px; font-weight: 600; margin: 0 0 12px; }
    .description {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 16px;
      line-height: 1.4;
    }
    .check-item {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 8px 0;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
    }
    .check-icon { width: 16px; text-align: center; }
    .check-icon.checking { color: var(--vscode-progressBar-background); }
    .check-icon.passed { color: var(--vscode-testing-iconPassed); }
    .check-icon.failed { color: var(--vscode-testing-iconFailed); }
    .check-info { flex: 1; min-width: 0; }
    .check-label { font-weight: 600; font-size: 13px; }
    .check-detail { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
    button {
      border: none;
      border-radius: 2px;
      cursor: pointer;
      font-size: 12px;
      padding: 4px 12px;
    }
    .action-btn {
      margin-top: 6px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .refresh-btn {
      margin-top: 16px;
      padding: 6px 14px;
      width: 100%;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .spinner { display: inline-block; animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <h2>DocBlocks Setup</h2>
  <div class="description">
    Set up your environment for the best DocBlocks experience with AI-assisted document creation.
  </div>
  <div id="checks">
    ${['node', 'npm', 'cli', 'mcp']
      .map(
        (id) => `<div class="check-item" id="check-${id}">
      <div class="check-icon checking"><span class="spinner">&#8635;</span></div>
      <div class="check-info">
        <div class="check-label">${id === 'node' ? 'Node.js' : id === 'npm' ? 'npm' : id === 'cli' ? 'DocBlocks CLI' : 'VS Code MCP'}</div>
        <div class="check-detail">Checking...</div>
      </div>
    </div>`,
      )
      .join('')}
  </div>
  <button class="refresh-btn" id="refresh" type="button">Re-check Environment</button>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const ids = ['node', 'npm', 'cli', 'mcp'];

    function runChecks() {
      for (const id of ids) {
        const element = document.getElementById('check-' + id);
        if (!element) continue;
        const icon = element.querySelector('.check-icon');
        const detail = element.querySelector('.check-detail');
        if (icon) {
          icon.className = 'check-icon checking';
          icon.textContent = '\u21bb';
        }
        if (detail) detail.textContent = 'Checking...';
        element.querySelector('.action-btn')?.remove();
      }
      vscode.postMessage({ type: 'runChecks' });
    }

    document.getElementById('refresh')?.addEventListener('click', runChecks);
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (!message || message.type !== 'checkResult' || !message.check) return;
      const check = message.check;
      if (!ids.includes(check.id)) return;
      const element = document.getElementById('check-' + check.id);
      if (!element) return;
      const icon = element.querySelector('.check-icon');
      const detail = element.querySelector('.check-detail');
      if (icon) {
        icon.className = 'check-icon ' + (check.status === 'passed' ? 'passed' : 'failed');
        icon.textContent = check.status === 'passed' ? '\u2713' : '\u2717';
      }
      if (detail) detail.textContent = typeof check.detail === 'string' ? check.detail : '';
      element.querySelector('.action-btn')?.remove();

      if (
        check.action === 'installNode' ||
        check.action === 'installCli' ||
        check.action === 'configureMcp'
      ) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'action-btn';
        button.textContent =
          check.action === 'installNode'
            ? 'Download Node.js'
            : check.action === 'installCli'
              ? 'Install DocBlocks CLI'
              : 'Register DocBlocks MCP';
        button.addEventListener('click', () => {
          vscode.postMessage({
            type:
              check.action === 'installNode'
                ? 'openNodeDownload'
                : check.action === 'installCli'
                  ? 'installCli'
                  : 'configureMcp',
          });
        });
        element.querySelector('.check-info')?.appendChild(button);
      }
    });
    runChecks();
  </script>
</body>
</html>`;
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled setup message: ${String(value)}`);
}
