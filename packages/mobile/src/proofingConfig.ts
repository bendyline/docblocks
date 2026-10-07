import {
  createDocBlocksProofingProvider,
  createLocalProofingDictionary,
} from '@bendyline/docblocks-react/proofing';

/**
 * Mobile proofing provider, pointed at the Harper engine this build bundles
 * under `/harper/` (see the `harperWasmPlugin` in `vite.config.ts`).
 *
 * A module-scope singleton, not a factory: the shell remounts the editor on
 * every document switch, and a host-owned instance keeps the warm engine alive
 * across those remounts instead of paying the cold WASM setup each time. The
 * host owns disposal for the lifetime of this WebView.
 *
 * The first Markdown document with checking enabled loads the engine from
 * the packaged assets. It does not require a network or service worker.
 */
export const SITE_PROOFING_PROVIDER = createDocBlocksProofingProvider({
  wasmUrl: `${import.meta.env.BASE_URL}harper/harper_wasm_bg.wasm`,
  dictionary: createLocalProofingDictionary(),
});
