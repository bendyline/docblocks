/**
 * Host wiring for Squisq's proofing capability — grammar and spellcheck by
 * [harper.js](https://github.com/Automattic/harper), Apache-2.0, running
 * entirely offline in a Web Worker.
 *
 * Every DocBlocks surface serves the same engine from its own origin, because
 * there is no CDN fallback and nothing may leave the device: the site
 * publishes it beside the PWA precache, the Electron renderer inside
 * `app.asar`, the VS Code webview inside the VSIX. Only two things differ per
 * surface — where the WASM lives and where an accepted word is remembered —
 * so those are the parameters here and everything else is shared.
 *
 * Nothing is downloaded by creating a provider. Squisq loads the engine
 * lazily, on the first markdown document with checking effective, so the
 * shell paints and the document opens whether or not the ~30 MiB binary pair
 * has arrived. A failed load is retried on the next use rather than cached.
 */

import { createHarperProofingProvider } from '@bendyline/squisq-editor-react/proofing';
import type { ProofingProvider } from '@bendyline/squisq-editor-react';
import type { ProofingDictionaryStore } from './proofing-dictionary.js';

export type { ProofingDictionaryStore } from './proofing-dictionary.js';
export { createLocalProofingDictionary } from './proofing-dictionary.js';
export type { ProofingIgnoreStorage } from './proofing-ignores.js';
export { createLocalProofingIgnoreStore, proofingIgnoreKey } from './proofing-ignores.js';

export interface DocBlocksProofingOptions {
  /**
   * URL of harper's full WASM binary as this surface publishes it. May be
   * root- or base-relative; the engine absolutizes it against the page before
   * handing it to the worker that does the fetching.
   *
   * The build must publish `harper_wasm_slim_bg.wasm` in the same directory:
   * the engine derives that sibling by substituting the file name and loads
   * both. See `scripts/vite-harper-wasm.ts`.
   */
  wasmUrl: string;
  /**
   * Where "Add to dictionary" persists app-wide. Omit for surfaces without
   * durable storage — a document's own `squisq-proof-dictionary` frontmatter
   * still applies either way.
   */
  dictionary?: ProofingDictionaryStore | null;
}

/**
 * Create the proofing provider a DocBlocks surface passes to its shell.
 *
 * Hold the result in module scope rather than creating one per render. The
 * shell remounts the editor on every document switch, and a host-owned
 * instance keeps the warm engine (a cold WASM setup costs seconds) alive
 * across those remounts; a provider the editor owns would be disposed and
 * rebuilt each time.
 */
export function createDocBlocksProofingProvider(
  options: DocBlocksProofingOptions,
): ProofingProvider {
  const { wasmUrl, dictionary } = options;
  return createHarperProofingProvider({
    wasmUrl,
    initialWords: dictionary?.read() ?? [],
    onDictionaryWord: dictionary ? (word) => dictionary.append(word) : undefined,
  });
}
