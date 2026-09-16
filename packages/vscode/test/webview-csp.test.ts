import { expect } from 'chai';
import { installVscodeStub, uninstallVscodeStub } from './helpers/vscodeStub.js';

/**
 * The webview's Content-Security-Policy, asserted against the directives the
 * shipped editor actually needs.
 *
 * `font-src` is here because it regressed: the bundled stylesheet embeds one
 * icon face (FontAwesome) as a `data:` URI, the site and desktop CSPs both
 * allow `data:` fonts, and the webview's did not. Chromium blocked the face and
 * reported it only to the console, so icons fell back silently while every
 * assertion still passed. The E2E runtime-error guard now fails on that class
 * of message; this test keeps the directive itself from drifting again.
 *
 * `webviewHelper` imports `vscode`, so it can only be required after the fake
 * module is installed — hence the lazy import rather than a static one.
 */

interface WebviewHelperModule {
  getEditorHtml(webview: unknown, extensionUri: unknown): string;
}

const CSP_SOURCE = 'https://file%2B.vscode-resource.vscode-cdn.net';

function parseDirectives(html: string): Map<string, readonly string[]> {
  const policyIndex = html.indexOf('http-equiv="Content-Security-Policy"');
  expect(policyIndex, 'the webview HTML must declare a Content-Security-Policy').to.be.greaterThan(
    -1,
  );
  const match = /content="([^"]*)"/u.exec(html.slice(policyIndex));
  expect(match, 'the policy must carry a content attribute').to.not.equal(null);

  const directives = new Map<string, readonly string[]>();
  for (const directive of match![1]!.split(';')) {
    const parts = directive.trim().split(/\s+/u).filter(Boolean);
    const name = parts.shift();
    if (name === undefined) continue;
    directives.set(name, parts);
  }
  return directives;
}

describe('VS Code webview content security policy', () => {
  let directives: Map<string, readonly string[]>;

  before(async () => {
    const stub = installVscodeStub();
    const helper = (await import('../src/webviewHelper.js')) as unknown as WebviewHelperModule;
    const Uri = stub.module.Uri as { file(path: string): unknown };
    const webview = {
      cspSource: CSP_SOURCE,
      asWebviewUri: (uri: unknown) => uri,
    };
    directives = parseDirectives(helper.getEditorHtml(webview, Uri.file('/extension')));
  });

  after(() => {
    uninstallVscodeStub();
  });

  it('starts from default-src none', () => {
    expect(directives.get('default-src')).to.deep.equal(["'none'"]);
  });

  it('allows the data: fonts the bundled stylesheet embeds', () => {
    const fontSrc = directives.get('font-src');
    expect(fontSrc, 'font-src must be declared').to.not.equal(undefined);
    expect(
      fontSrc,
      'the bundled stylesheet embeds an icon face as a data: URI; site and desktop both allow it',
    ).to.include('data:');
  });

  it('keeps the extension origin as the source for every bundled resource', () => {
    for (const directive of ['style-src', 'script-src', 'font-src', 'img-src', 'connect-src']) {
      expect(directives.get(directive), directive).to.include(CSP_SOURCE);
    }
  });

  it('permits the WebAssembly compilation the proofing and calculation engines need', () => {
    expect(directives.get('script-src')).to.include("'wasm-unsafe-eval'");
  });

  it('does not widen font-src to a remote origin or a wildcard', () => {
    const fontSrc = directives.get('font-src') ?? [];
    expect(fontSrc).to.not.include('*');
    for (const source of fontSrc) {
      if (source === CSP_SOURCE || source === 'data:') continue;
      expect.fail(`font-src must not carry an extra source: ${source}`);
    }
  });
});
