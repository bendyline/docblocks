import * as vscode from 'vscode';
import { parseExternalHttpUrl } from '@bendyline/docblocks/host';
import { parseSetupWebviewMessage, type SetupWebviewMessage } from './setupMessages.js';
import { getNonce } from './webviewHelper.js';

interface CheckResult {
  id: string;
  status: 'checking' | 'passed' | 'failed';
  label: string;
  detail?: string;
  action?: 'installNode' | 'installCli';
}

const NODE_DOWNLOAD_URL = 'https://nodejs.org/en/download/';
const ACTION_COOLDOWN_MS = 1_000;

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
        this.runInTerminal('npm install -g @bendyline/docblocks-cli');
        return;

      case 'initProject': {
        if (!this.acceptAction(message.type) || !(await this.requireTrustedWorkspace())) return;
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (folder) {
          this.runInTerminal('docblocks init', folder.uri.fsPath);
        } else {
          await vscode.window.showWarningMessage(
            'Open a folder first to initialize a DocBlocks project.',
          );
        }
        return;
      }

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
    const [nodeResult, npmResult, cliResult] = await Promise.all([
      this.checkCommand('node', ['--version']),
      this.checkCommand('npm', ['--version']),
      this.checkCommand('docblocks', ['--version']),
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
      {
        id: 'cli',
        status: cliResult ? 'passed' : 'failed',
        label: 'DocBlocks CLI',
        detail: cliResult ? `Available: v${cliResult.trim()}` : 'Not installed',
        action: cliResult ? undefined : 'installCli',
      },
    ];

    for (const check of checks) {
      await webview.postMessage({ type: 'checkResult', check });
    }
    await webview.postMessage({ type: 'checksComplete' });
  }

  private async checkCommand(command: string, args: readonly string[]): Promise<string | null> {
    try {
      const { execFile } = await import('child_process');
      const isWin = typeof process !== 'undefined' && process.platform === 'win32';
      const executable = isWin && command !== 'node' ? `${command}.cmd` : command;
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
          executable,
          [...args],
          { timeout: 15_000, maxBuffer: 16 * 1024, windowsHide: true, env },
          (error, stdout) => resolve(error ? null : stdout.slice(0, 256)),
        );
      });
    } catch {
      // child_process is intentionally unavailable in vscode.dev.
      return null;
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

  private runInTerminal(command: string, cwd?: string): void {
    const terminal = vscode.window.createTerminal({ name: 'DocBlocks Setup', cwd });
    terminal.sendText(command);
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
    ${['node', 'npm', 'cli']
      .map(
        (id) => `<div class="check-item" id="check-${id}">
      <div class="check-icon checking"><span class="spinner">&#8635;</span></div>
      <div class="check-info">
        <div class="check-label">${id === 'node' ? 'Node.js' : id === 'npm' ? 'npm' : 'DocBlocks CLI'}</div>
        <div class="check-detail">Checking...</div>
      </div>
    </div>`,
      )
      .join('')}
  </div>
  <button class="refresh-btn" id="refresh" type="button">Re-check Environment</button>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const ids = ['node', 'npm', 'cli'];

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

      if (check.action === 'installNode' || check.action === 'installCli') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'action-btn';
        button.textContent = check.action === 'installNode' ? 'Download Node.js' : 'Install DocBlocks CLI';
        button.addEventListener('click', () => {
          vscode.postMessage({
            type: check.action === 'installNode' ? 'openNodeDownload' : 'installCli',
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
