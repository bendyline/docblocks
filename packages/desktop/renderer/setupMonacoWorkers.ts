/**
 * Monaco language-service web workers for the DocBlocks desktop renderer.
 *
 * The `?worker` imports are Vite-specific, so this bundler-facing glue lives
 * in the renderer (not in the tsup-built squisq / docblocks-react libraries).
 * squisq owns the label→worker mapping via configureMonacoWorkers; we just
 * supply the five constructors. Imported for side effect from main.tsx before
 * the app mounts.
 *
 * Workers load over the renderer's `app://` custom protocol (which is
 * configured to serve them) and, per the renderer Vite config's
 * `worker.format: 'es'`, run as ES module workers.
 */
import { configureMonacoWorkers } from '@bendyline/squisq-editor-react/monaco-workers';
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
