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
  IRONCALC_WASM_META_NAME: string;
  getEditorHtml(webview: unknown, extensionUri: unknown): string;
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webviewCalculationSource = readFileSync(
  path.join(packageRoot, 'webview', 'src', 'calculationConfig.ts'),
  'utf8',
);

let helper: WebviewHelperModule;
let html: string;

describe('VS Code webview calculation wiring', () => {
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
    expect(html).to.include(`<meta name="${helper.IRONCALC_WASM_META_NAME}"`);
    expect(html).to.include('/extension/dist/webview/ironcalc/wasm_bg.wasm');
  });

  it('agrees with the webview on where to read that location', () => {
    expect(webviewCalculationSource).to.include(
      `const IRONCALC_WASM_META_NAME = '${helper.IRONCALC_WASM_META_NAME}'`,
    );
  });

  it('allows the webview to fetch and compile the packaged engine', () => {
    expect(html).to.match(/script-src[^;]*'wasm-unsafe-eval'/u);
    expect(html).to.match(/connect-src vscode-webview:\/\/stub;/u);
  });

  it('degrades to the in-house tier when the host stamps no location', () => {
    expect(webviewCalculationSource).to.include('if (!wasmUrl) return null;');
  });
});
