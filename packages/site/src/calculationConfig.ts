import { createDocBlocksCalcEngineFactory } from '@bendyline/docblocks-react/calculation';
import type { CalcEngineFactory } from '@bendyline/squisq-editor-react';

/**
 * Lazy site calculation backend, pointed at the IronCalc binary this build
 * publishes and precaches under `/ironcalc/`.
 */
export const SITE_CALC_ENGINE_FACTORY: CalcEngineFactory = createDocBlocksCalcEngineFactory({
  wasmSource: `${import.meta.env.BASE_URL}ironcalc/wasm_bg.wasm`,
});
