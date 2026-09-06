import { createDocBlocksProofingProvider } from '@bendyline/docblocks-react/proofing';
import type { ProofingProvider } from '@bendyline/squisq-editor-react';

/**
 * Must match `HARPER_WASM_META_NAME` in `src/webviewHelper.ts`. The webview
 * cannot import from the extension host — that boundary is postMessage only —
 * so the two ends of this contract are pinned by
 * `test/webview-proofing.test.ts`.
 */
const HARPER_WASM_META_NAME = 'docblocks-harper-wasm';

/** The engine URL the extension host stamped into this document, if any. */
function readHarperWasmUrl(): string | null {
  const meta = document.querySelector(`meta[name="${HARPER_WASM_META_NAME}"]`);
  return meta?.getAttribute('content') || null;
}

/**
 * Build the proofing provider for the VS Code webview, pointed at the harper
 * engine shipped inside the VSIX.
 *
 * The extension host stamps the resolved webview URI into the document,
 * because a raw extension path is not fetchable and a URL derived inside the
 * bundle would resolve against whichever chunk this module landed in. A
 * document opened without that meta tag — an older host, or a stripped
 * package — gets no proofing rather than a broken engine.
 *
 * `initialWords` must already be in hand: seeding the dictionary after
 * construction would force the engine to load before anyone asked for it.
 * Passing `onDictionaryWord` is also what makes Squisq offer "Add to
 * dictionary" at all — without a place to put a word, it shows only the
 * document word list.
 */
export function createVscodeProofingProvider(
  initialWords: readonly string[],
  onDictionaryWord: (word: string) => void,
): ProofingProvider | null {
  const wasmUrl = readHarperWasmUrl();
  if (!wasmUrl) return null;
  return createDocBlocksProofingProvider({
    wasmUrl,
    dictionary: {
      read: () => initialWords,
      append: onDictionaryWord,
    },
  });
}
