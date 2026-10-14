/**
 * Resolution settings for the web extension bundle (`dist/extension.web.js`).
 *
 * vscode.dev runs web extensions in a Web Worker, which has no DOM. Packages
 * that publish a DOM build under `browser` and a worker-safe one under
 * `worker` must resolve to the latter: decode-named-character-reference's
 * `index.dom.js` creates an element on load, which failed every workspace
 * catalog on vscode.dev. `module` is esbuild's default custom condition and
 * stays. Shared by tsup.config.ts and test/web-extension-bundle.test.ts.
 */
export const WEB_EXTENSION_CONDITIONS: string[] = ['worker', 'module'];
