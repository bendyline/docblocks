import { createDocBlocksCalcEngineFactory } from '@bendyline/docblocks-react/calculation';
import type { CalcEngineFactory } from '@bendyline/squisq-editor-react';

/**
 * Lazy mobile calculation backend, pointed at the IronCalc binary bundled
 * under `/ironcalc/` in the native application.
 */
export const SITE_CALC_ENGINE_FACTORY: CalcEngineFactory = createDocBlocksCalcEngineFactory({
  wasmSource: `${import.meta.env.BASE_URL}ironcalc/wasm_bg.wasm`,
});
