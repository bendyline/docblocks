import { createDocBlocksCalcEngineFactory } from '@bendyline/docblocks-react/calculation';

/**
 * Lazy site calculation backend, pointed at the IronCalc binary this build
 * publishes and precaches under `/ironcalc/`.
 */
export const SITE_CALC_ENGINE_FACTORY = createDocBlocksCalcEngineFactory({
  wasmSource: `${import.meta.env.BASE_URL}ironcalc/wasm_bg.wasm`,
});
