/**
 * Slim Monaco editor bundle — only markdown + a few useful languages.
 *
 * The full monaco-editor includes 90+ language workers (7MB+).
 * We only need markdown for the docblocks editor, plus a handful
 * of common languages that may appear in fenced code blocks.
 */

// Core editor functionality
export * from 'monaco-editor/esm/vs/editor/editor.api';

// ── Languages ──────────────────────────────────────────────────────
// Markdown (primary)
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution';

// Common languages for fenced code blocks
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution';
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution';
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution';
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution';
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution';
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution';
