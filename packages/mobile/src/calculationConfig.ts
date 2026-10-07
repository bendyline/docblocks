import { createDocBlocksCalcEngineFactory } from '@bendyline/docblocks-react/calculation';

/**
 * Lazy mobile calculation backend, pointed at the IronCalc binary bundled
 * under `/ironcalc/` in the native application.
 */
export const SITE_CALC_ENGINE_FACTORY = createDocBlocksCalcEngineFactory({
  wasmSource: `${import.meta.env.BASE_URL}ironcalc/wasm_bg.wasm`,
});
