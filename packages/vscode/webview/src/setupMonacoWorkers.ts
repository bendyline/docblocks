/**
 * Monaco language-service web workers for the VS Code webview.
 *
 * Same pattern as the site/desktop entries: the `?worker` imports are
 * Vite-specific, so they live in the app; squisq owns the label→worker
 * mapping via configureMonacoWorkers. Imported for side effect from main.tsx
 * before the app mounts.
 *
 * Webview specifics: the bundle is served over the `vscode-webview-resource:`
 * origin, so these workers load from `webview.cspSource` (not `blob:`). The
 * webview HTML's CSP `worker-src` must therefore allow `${webview.cspSource}`
 * — see getEditorHtml() in src/webviewHelper.ts. `import.meta.url` is
 * available because the entry is loaded as `<script type="module">`, so Vite's
 * `new URL(worker, import.meta.url)` resolves against that same origin.
 */
import { configureMonacoWorkers } from '@bendyline/squisq-editor-react';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

configureMonacoWorkers({
  editor: EditorWorker,
  json: JsonWorker,
  css: CssWorker,
  html: HtmlWorker,
  ts: TsWorker,
});
