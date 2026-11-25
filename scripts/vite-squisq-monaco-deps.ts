/**
 * The Monaco modules Squisq's source editor imports by deep path, for a dev
 * server's `optimizeDeps.include`.
 *
 * Squisq loads Monaco's API entry plus a chosen set of feature and language
 * contributions (`monaco-editor/esm/vs/...`), never the full `editor.main`.
 * Those imports live inside the excluded Squisq editor package, so Vite's
 * startup scan never sees them. Left unlisted, the first page to open the
 * source view makes Vite discover about sixty modules, re-optimize, and reload
 * every open page; a parallel E2E run loses whichever tests were mid-flight.
 *
 * The list is read from the editor package's built `dist/`, whichever copy is
 * installed or linked, so it follows Squisq instead of drifting from it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A quoted `monaco-editor/esm/…/*.js` specifier. A `?worker` import never matches. */
const MONACO_DEEP_IMPORT = /["'`](monaco-editor\/esm\/[^"'`?\s]+\.js)["'`]/g;

/** Built JavaScript, not declarations or source maps. */
const BUILT_SCRIPT = /\.m?js$/;

/** Every deep Monaco module the Squisq editor's build imports, sorted; [] before install. */
export function squisqMonacoDeepImports(root: string = repoRoot): string[] {
  const dist = path.join(root, 'node_modules', '@bendyline', 'squisq-editor-react', 'dist');
  let files: string[];
  try {
    files = fs.readdirSync(dist, { recursive: true, encoding: 'utf8' });
  } catch {
    return [];
  }
  const found = new Set<string>();
  for (const file of files) {
    if (!BUILT_SCRIPT.test(file) || file.endsWith('.d.ts')) continue;
    const source = fs.readFileSync(path.join(dist, file), 'utf8');
    for (const match of source.matchAll(MONACO_DEEP_IMPORT)) found.add(match[1]);
  }
  return [...found].sort();
}
