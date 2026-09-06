import { createDocBlocksCalcEngineFactory } from '@bendyline/docblocks-react/calculation';
import type { CalcEngineFactory } from '@bendyline/squisq-editor-react';

/** Must match `IRONCALC_WASM_META_NAME` in `src/webviewHelper.ts`. */
const IRONCALC_WASM_META_NAME = 'docblocks-ironcalc-wasm';

/**
 * Build the lazy calculation factory for the VS Code webview, pointed at the
 * IronCalc binary shipped inside the VSIX. A missing host-stamped URL leaves
 * Squisq on its in-house tier rather than creating a broken backend.
 */
export function createVscodeCalcEngineFactory(): CalcEngineFactory | null {
  const meta = document.querySelector(`meta[name="${IRONCALC_WASM_META_NAME}"]`);
  const wasmUrl = meta?.getAttribute('content') || null;
  if (!wasmUrl) return null;
  return createDocBlocksCalcEngineFactory({ wasmSource: wasmUrl });
}
