import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  installVscodeStub,
  uninstallVscodeStub,
  FakeUri,
  FakeWebviewPanel,
} from './helpers/vscodeStub.js';

interface WebviewHelperModule {
  HARPER_WASM_META_NAME: string;
  getEditorHtml(webview: unknown, extensionUri: unknown): string;
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webviewProofingSource = readFileSync(
  path.join(packageRoot, 'webview', 'src', 'proofingConfig.ts'),
  'utf8',
);

let helper: WebviewHelperModule;
let html: string;

/**
 * Proofing is the first capability that needs the webview to fetch a packaged
 * binary. That crosses the one boundary this extension cannot type-check —
 * the host builds the HTML, the sandboxed bundle reads it back — so the two
 * ends are pinned here instead.
 */
describe('VS Code webview proofing wiring', () => {
  before(async () => {
    installVscodeStub();
    helper = (await import('../src/webviewHelper.js')) as unknown as WebviewHelperModule;
    const panel = new FakeWebviewPanel();
    html = helper.getEditorHtml(panel.webview, new FakeUri('/extension'));
  });

  after(() => {
    uninstallVscodeStub();
  });

  it('stamps the packaged engine location into the document', () => {
    expect(html).to.include(`<meta name="${helper.HARPER_WASM_META_NAME}"`);
    expect(html).to.include('/extension/dist/webview/harper/harper_wasm_bg.wasm');
  });

  it('agrees with the webview on where to read that location', () => {
    // The webview cannot import from the extension host, so the meta name is
    // duplicated by necessity. Two copies that drift silently disable proofing.
    expect(webviewProofingSource).to.include(
      `const HARPER_WASM_META_NAME = '${helper.HARPER_WASM_META_NAME}'`,
    );
  });

  it('allows WebAssembly compilation', () => {
    // Chromium refuses to compile WASM without this, and the failure surfaces
    // as a stuck "Proofing…" status rather than an error anyone would notice.
    expect(html).to.match(/script-src[^;]*'wasm-unsafe-eval'/u);
  });

  it('lets the page fetch the binary and the engine worker read its blob copy', () => {
    // The page downloads the WASM from the webview resource origin, then hands
    // harper's blob worker — which inherits this document's policy — a blob:
    // URL. Under `default-src 'none'` both reads need an explicit connect-src.
    expect(html).to.match(/connect-src vscode-webview:\/\/stub[ ;]/u);
    expect(html).to.match(/connect-src[^;]*\bblob:/u);
    expect(html).to.match(/worker-src[^;]*blob:/u);
  });

  it('never gives the engine worker a webview resource URL', () => {
    // Desktop hosts answer a worker's webview-resource fetch with a 30 s
    // `408 Request Timeout`, which leaves proofing stuck on "Proofing…".
    expect(webviewProofingSource).to.include('wasmUrl: await engine.resolve()');
    expect(webviewProofingSource).not.to.match(/createDocBlocksProofingProvider\(\{\s*wasmUrl,/u);
  });

  it('degrades to no proofing when the host stamps no location', () => {
    expect(webviewProofingSource).to.include('if (!wasmUrl) return null;');
  });
});
