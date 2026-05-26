/**
 * Slim Monaco editor bundle for DocBlocks browser surfaces.
 *
 * Squisq's raw editor lazy-loads `monaco-editor/esm/vs/editor/editor.main.js`
 * so syntax highlighting works in raw mode. Alias both that subpath and the
 * bare `monaco-editor` specifier to this file to keep the lazy chunk focused
 * on markdown plus the languages users most often place in fenced blocks.
 */

export * from 'monaco-editor/esm/vs/editor/editor.api';

import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution';
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution';
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution';
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution';
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution';
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution';
