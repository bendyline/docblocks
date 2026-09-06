import * as vscode from 'vscode';
import { fillRandomBytes } from './random.js';

/**
 * Generate a random nonce for CSP.
 * Uses the platform Web Crypto source or Node's CSPRNG in older desktop hosts.
 */
export function getNonce(): string {
  const bytes = new Uint8Array(16);
  fillRandomBytes(bytes);
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
 * Where the webview reads the proofing engine's location. A webview resource
 * only becomes fetchable once `asWebviewUri` has rewritten it for the host,
 * and only the extension side can do that — so the URL is stamped into the
 * document rather than derived in the bundle, which resolves relative to
 * whichever chunk the resolving module landed in.
 */
export const HARPER_WASM_META_NAME = 'docblocks-harper-wasm';

/** Where the webview reads the packaged IronCalc engine's location. */
export const IRONCALC_WASM_META_NAME = 'docblocks-ironcalc-wasm';

/**
 * Generate the HTML for the editor webview.
 */
export function getEditorHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const distUri = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'index.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'index.css'));
  // harper derives its slim sibling from this file name, so both binaries are
  // published side by side under dist/webview/harper/ and only the full one is
  // named here. The VSIX carries them; nothing is downloaded at runtime.
  const harperWasmUri = webview.asWebviewUri(
    vscode.Uri.joinPath(distUri, 'harper', 'harper_wasm_bg.wasm'),
  );
  const ironCalcWasmUri = webview.asWebviewUri(
    vscode.Uri.joinPath(distUri, 'ironcalc', 'wasm_bg.wasm'),
  );
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
      style-src ${webview.cspSource} 'unsafe-inline';
      script-src ${webview.cspSource} 'nonce-${nonce}' 'wasm-unsafe-eval';
      font-src ${webview.cspSource};
      img-src ${webview.cspSource} blob: data:;
      media-src blob: data:;
      connect-src ${webview.cspSource};
      worker-src ${webview.cspSource} blob:;">
  <meta name="${HARPER_WASM_META_NAME}" content="${harperWasmUri.toString()}">
  <meta name="${IRONCALC_WASM_META_NAME}" content="${ironCalcWasmUri.toString()}">
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
