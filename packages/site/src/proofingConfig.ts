import {
  createDocBlocksProofingProvider,
  createLocalProofingDictionary,
} from '@bendyline/docblocks-react/proofing';

/**
 * Site proofing provider, pointed at the harper engine this build publishes
 * under `/harper/` (see the `harperWasmPlugin` in `vite.config.ts`).
 *
 * A module-scope singleton, not a factory: the shell remounts the editor on
 * every document switch, and a host-owned instance keeps the warm engine alive
 * across those remounts instead of paying the cold WASM setup each time. The
 * site owns disposal, which for a tab that lives as long as the app is never.
 *
 * Creating it downloads nothing. The engine is fetched on the first markdown
 * document with checking effective — from the service-worker precache once
 * installation finishes, and straight from the network before that.
 */
export const SITE_PROOFING_PROVIDER = createDocBlocksProofingProvider({
  wasmUrl: `${import.meta.env.BASE_URL}harper/harper_wasm_bg.wasm`,
  dictionary: createLocalProofingDictionary(),
});
