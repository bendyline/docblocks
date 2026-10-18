import { createDocBlocksProofingProvider } from '@bendyline/docblocks-react/proofing';
import type { ProofingProvider } from '@bendyline/squisq-editor-react';
import { createDeferredProofingProvider } from './deferredProofingProvider.js';
import { createProofingEngineSource } from './proofingEngineSource.js';

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
 * That URL is fetched by this page, never handed to the engine directly: the
 * engine's worker cannot fetch webview resources on current desktop hosts, so
 * it is given a `blob:` copy instead (see `proofingEngineSource.ts`). The copy
 * is made on first use, so a document that never proofs downloads nothing.
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
  const engine = createProofingEngineSource(wasmUrl);
  return createDeferredProofingProvider({
    // The dictionary callback below is always wired, so app-wide additions
    // persist — the same answer the built provider would give.
    hasAppDictionary: true,
    create: async () =>
      createDocBlocksProofingProvider({
        wasmUrl: await engine.resolve(),
        dictionary: {
          read: () => initialWords,
          append: onDictionaryWord,
        },
      }),
    onDispose: () => engine.dispose(),
  });
}
