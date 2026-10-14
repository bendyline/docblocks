import { createDocBlocksCalcEngineFactory } from '@bendyline/docblocks-react/calculation';
import type { CalcEngineFactory } from '@bendyline/squisq-editor-react';

/**
 * Lazy desktop calculation backend. The `app://` protocol serves this binary
 * from the installed renderer, so IronCalc is available without a network.
 */
export const DESKTOP_CALC_ENGINE_FACTORY: CalcEngineFactory = createDocBlocksCalcEngineFactory({
  wasmSource: `${import.meta.env.BASE_URL}ironcalc/wasm_bg.wasm`,
});
