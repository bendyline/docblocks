import { expect } from 'chai';
import { build } from 'esbuild';
import path from 'node:path';
import vm from 'node:vm';
import { WEB_EXTENSION_CONDITIONS } from '../web-extension-build.js';

/**
 * vscode.dev runs the web extension in a Web Worker: web platform APIs, no DOM.
 * Catalogs render there, so the modules they load must evaluate without
 * `document`. This bundles them the way tsup builds `extension.web.js` and runs
 * them in such a scope (a fresh context, clear of the suite's happy-dom globals).
 */
async function loadForWebWorker(): Promise<Record<string, unknown>> {
  const result = await build({
    stdin: {
      contents: [
        "export * from '@bendyline/squisq-formats/html';",
        "export * as settings from '@bendyline/docblocks/workspace-settings';",
      ].join('\n'),
      resolveDir: path.resolve(__dirname, '..'),
    },
    bundle: true,
    write: false,
    platform: 'browser',
    conditions: WEB_EXTENSION_CONDITIONS,
    format: 'iife',
    globalName: 'catalogModules',
    logLevel: 'silent',
  });
  const worker: Record<string, unknown> = {
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    atob,
    btoa,
    structuredClone,
  };
  worker.self = worker;
  const context = vm.createContext(worker);
  vm.runInContext(result.outputFiles[0]?.text ?? '', context);
  return context.catalogModules as Record<string, unknown>;
}

describe('web extension bundle', () => {
  it('loads and renders catalogs in a worker without a DOM', async () => {
    const modules = await loadForWebWorker();
    const htmlToMarkdownDocSync = modules.htmlToMarkdownDocSync as (html: string) => unknown;
    const markdownDocToPlainHtml = modules.markdownDocToPlainHtml as (
      document: unknown,
      options: { title: string },
    ) => string;
    const document = htmlToMarkdownDocSync('<h1>Caf&eacute; notes</h1><p>Soil &amp; water.</p>');
    const html = markdownDocToPlainHtml(document, { title: 'Field notes' });
    expect(html).to.contain('Café notes');
    expect(modules.settings).to.be.an('object');
  });
});
