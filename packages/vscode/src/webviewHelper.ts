import * as vscode from 'vscode';

/**
 * Generate a random nonce for CSP.
 * Uses globalThis.crypto which works in both Node.js and web workers.
 */
export function getNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Get the current VS Code theme as 'light' or 'dark'.
 */
export function getVscodeTheme(): 'light' | 'dark' {
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast
    ? 'dark'
    : 'light';
}

/**
 * Generate the HTML for the editor webview.
 */
export function getEditorHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const distUri = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'index.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'index.css'));
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
      style-src ${webview.cspSource} 'unsafe-inline';
      script-src 'nonce-${nonce}';
      font-src ${webview.cspSource};
      img-src ${webview.cspSource} blob: data:;
      worker-src blob:;">
  <link rel="stylesheet" href="${styleUri}">
  <style>
    html, body, #root {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <!--
    Loaded as an ES module so Monaco's lazy language loaders can use
    import.meta.url. A plain <script> tag would parse-error on the
    bundle's import.meta references.
  -->
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
