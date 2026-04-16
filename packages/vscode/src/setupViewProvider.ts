import * as vscode from 'vscode';

interface CheckResult {
  id: string;
  status: 'checking' | 'passed' | 'failed';
  label: string;
  detail?: string;
  action?: string;
}

export class SetupViewProvider {
  public static readonly viewType = 'docblocks.setupView';
  private static currentPanel: vscode.WebviewPanel | undefined;

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
      { enableScripts: true, retainContextWhenHidden: true },
    );

    SetupViewProvider.currentPanel = panel;
    panel.onDidDispose(() => {
      SetupViewProvider.currentPanel = undefined;
    });

    new SetupViewProvider(context).attach(panel.webview);
  }

  private attach(webview: vscode.Webview): void {
    webview.html = this.getHtml();

    webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'runChecks':
          await this.runChecks(webview);
          break;

        case 'openLink':
          vscode.env.openExternal(vscode.Uri.parse(msg.url));
          break;

        case 'installCli':
          this.runInTerminal('npm install -g @bendyline/docblocks-cli');
          break;

        case 'initProject': {
          const folder = vscode.workspace.workspaceFolders?.[0];
          if (folder) {
            this.runInTerminal('docblocks init', folder.uri.fsPath);
          } else {
            vscode.window.showWarningMessage(
              'Open a folder first to initialize a DocBlocks project.',
            );
          }
          break;
        }

        case 'refreshChecks':
          await this.runChecks(webview);
          break;
      }
    });
  }

  private async runChecks(webview: vscode.Webview): Promise<void> {
    // Check Node.js
    const nodeResult = await this.checkCommand('node --version');
    webview.postMessage({
      type: 'checkResult',
      check: {
        id: 'node',
        status: nodeResult ? 'passed' : 'failed',
        label: 'Node.js',
        detail: nodeResult ? `Installed: ${nodeResult.trim()}` : 'Not found',
        action: nodeResult ? undefined : 'installNode',
      } satisfies CheckResult,
    });

    // Check npm
    const npmResult = await this.checkCommand('npm --version');
    webview.postMessage({
      type: 'checkResult',
      check: {
        id: 'npm',
        status: npmResult ? 'passed' : 'failed',
        label: 'npm',
        detail: npmResult ? `Installed: v${npmResult.trim()}` : 'Not found (comes with Node.js)',
        action: npmResult ? undefined : 'installNode',
      } satisfies CheckResult,
    });

    // Check DocBlocks CLI
    const cliResult = await this.checkCommand('npx @bendyline/docblocks-cli --version');
    webview.postMessage({
      type: 'checkResult',
      check: {
        id: 'cli',
        status: cliResult ? 'passed' : 'failed',
        label: 'DocBlocks CLI',
        detail: cliResult ? `Available: v${cliResult.trim()}` : 'Not installed',
        action: cliResult ? undefined : 'installCli',
      } satisfies CheckResult,
    });

    webview.postMessage({ type: 'checksComplete' });
  }

  private async checkCommand(command: string): Promise<string | null> {
    try {
      const { exec } = await import('child_process');
      const isWin = process.platform === 'win32';
      const extraPaths = isWin
        ? ''
        : '/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/sbin';
      const currentPath = process.env.PATH || '';
      const env = {
        ...process.env,
        PATH: extraPaths ? `${extraPaths}:${currentPath}` : currentPath,
      };
      return new Promise((resolve) => {
        exec(command, { timeout: 15000, env }, (err, stdout, stderr) => {
          if (err) {
            console.error(
              `[DocBlocks] checkCommand failed: ${command}`,
              err.message,
              `PATH=${env.PATH}`,
            );
            resolve(null);
          } else {
            resolve(stdout);
          }
        });
      });
    } catch (e) {
      // child_process not available in web context
      console.error('[DocBlocks] child_process unavailable:', e);
      return null;
    }
  }

  private runInTerminal(command: string, cwd?: string): void {
    const terminal = vscode.window.createTerminal({
      name: 'DocBlocks Setup',
      cwd,
    });
    terminal.sendText(command);
    terminal.show();
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      padding: 12px;
      margin: 0;
    }

    h2 {
      font-size: 14px;
      font-weight: 600;
      margin: 0 0 12px 0;
      color: var(--vscode-foreground);
    }

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

    .check-item:last-child {
      border-bottom: none;
    }

    .check-icon {
      flex-shrink: 0;
      width: 16px;
      height: 16px;
      line-height: 16px;
      text-align: center;
      font-size: 14px;
    }

    .check-icon.checking { color: var(--vscode-progressBar-background); }
    .check-icon.passed { color: var(--vscode-testing-iconPassed); }
    .check-icon.failed { color: var(--vscode-testing-iconFailed); }

    .check-info {
      flex: 1;
      min-width: 0;
    }

    .check-label {
      font-weight: 600;
      font-size: 13px;
    }

    .check-detail {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-top: 2px;
    }

    .action-btn {
      display: inline-block;
      margin-top: 6px;
      padding: 4px 12px;
      font-size: 12px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 2px;
      cursor: pointer;
    }

    .action-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .refresh-btn {
      margin-top: 16px;
      padding: 6px 14px;
      font-size: 12px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 2px;
      cursor: pointer;
      width: 100%;
    }

    .refresh-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .spinner {
      display: inline-block;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <h2>DocBlocks Setup</h2>
  <div class="description">
    Set up your environment for the best DocBlocks experience with GitHub Copilot and AI-assisted document creation.
  </div>

  <div id="checks">
    <div class="check-item" id="check-node">
      <div class="check-icon checking"><span class="spinner">&#8635;</span></div>
      <div class="check-info">
        <div class="check-label">Node.js</div>
        <div class="check-detail">Checking...</div>
      </div>
    </div>
    <div class="check-item" id="check-npm">
      <div class="check-icon checking"><span class="spinner">&#8635;</span></div>
      <div class="check-info">
        <div class="check-label">npm</div>
        <div class="check-detail">Checking...</div>
      </div>
    </div>
    <div class="check-item" id="check-cli">
      <div class="check-icon checking"><span class="spinner">&#8635;</span></div>
      <div class="check-info">
        <div class="check-label">DocBlocks CLI</div>
        <div class="check-detail">Checking...</div>
      </div>
    </div>
  </div>

  <button class="refresh-btn" onclick="runChecks()">Re-check Environment</button>

  <script>
    const vscode = acquireVsCodeApi();

    function runChecks() {
      // Reset all to checking state
      ['node', 'npm', 'cli'].forEach(id => {
        const el = document.getElementById('check-' + id);
        if (el) {
          el.querySelector('.check-icon').className = 'check-icon checking';
          el.querySelector('.check-icon').innerHTML = '<span class="spinner">&#8635;</span>';
          el.querySelector('.check-detail').textContent = 'Checking...';
          const btn = el.querySelector('.action-btn');
          if (btn) btn.remove();
        }
      });
      vscode.postMessage({ type: 'runChecks' });
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'checkResult') {
        const check = msg.check;
        const el = document.getElementById('check-' + check.id);
        if (!el) return;

        const icon = el.querySelector('.check-icon');
        const detail = el.querySelector('.check-detail');

        icon.className = 'check-icon ' + check.status;
        if (check.status === 'passed') {
          icon.innerHTML = '&#10003;';
        } else if (check.status === 'failed') {
          icon.innerHTML = '&#10007;';
        }

        detail.textContent = check.detail || '';

        // Add action button if needed
        const existing = el.querySelector('.action-btn');
        if (existing) existing.remove();

        if (check.action) {
          const btn = document.createElement('button');
          btn.className = 'action-btn';

          switch (check.action) {
            case 'installNode':
              btn.textContent = 'Download Node.js';
              btn.onclick = () => vscode.postMessage({ type: 'openLink', url: 'https://nodejs.org' });
              break;
            case 'installCli':
              btn.textContent = 'Install DocBlocks CLI';
              btn.onclick = () => vscode.postMessage({ type: 'installCli' });
              break;
          }

          el.querySelector('.check-info').appendChild(btn);
        }
      }
    });

    // Run checks on load
    runChecks();
  </script>
</body>
</html>`;
  }
}
