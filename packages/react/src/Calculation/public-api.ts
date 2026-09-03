/**
 * Host wiring for Squisq's optional IronCalc spreadsheet engine.
 *
 * Creating the factory imports no engine code and downloads no bytes. Squisq
 * calls it only when a formula session opens, at which point the IronCalc
 * adapter and the surface's same-origin WASM asset load asynchronously. If the
 * factory rejects, Squisq falls back to its in-house calculation tier.
 */

import type { CalcEngineFactory } from '@bendyline/squisq-editor-react';

export interface DocBlocksCalculationOptions {
  /**
   * `@ironcalc/wasm` binary source. Browser hosts normally pass the stable
   * same-origin URL they publish; tests and non-browser hosts may pass bytes
   * or a compiled module instead.
   */
  wasmSource: string | URL | Response | BufferSource | WebAssembly.Module;
  /** IronCalc workbook locale. Defaults to `en`. */
  locale?: string;
  /** IronCalc workbook timezone. Defaults to `UTC`. */
  timezone?: string;
}

/** Create the lazy IronCalc factory a DocBlocks surface passes to its shell. */
export function createDocBlocksCalcEngineFactory(
  options: DocBlocksCalculationOptions,
): CalcEngineFactory {
  const { wasmSource, locale, timezone } = options;
  return async (config) => {
    const { createIronCalcEngine } = await import('@bendyline/squisq-calc/ironcalc');
    return createIronCalcEngine({
      ...config,
      wasmSource,
      locale,
      timezone,
    });
  };
}
