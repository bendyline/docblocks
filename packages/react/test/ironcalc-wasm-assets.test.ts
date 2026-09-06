import { expect } from 'chai';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocBlocksCalcEngineFactory } from '../src/Calculation/public-api.js';
import {
  IRONCALC_PUBLISHED_FILES,
  IRONCALC_WASM_FILE_NAME,
} from '../../../scripts/vite-ironcalc-wasm.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ironCalcWasmPath = path.join(repoRoot, 'node_modules', '@ironcalc', 'wasm', 'wasm_bg.wasm');

describe('IronCalc engine assets', () => {
  it('publishes the stable binary name and selected upstream license', () => {
    expect([...IRONCALC_PUBLISHED_FILES.keys()]).to.have.members([
      'wasm_bg.wasm',
      'LICENSE-MIT.txt',
    ]);
    expect(IRONCALC_WASM_FILE_NAME).to.equal('wasm_bg.wasm');
  });

  it('resolves every published file inside the repository', () => {
    for (const [publishedName, relativePath] of IRONCALC_PUBLISHED_FILES) {
      const source = path.join(repoRoot, relativePath);
      expect(existsSync(source), `${publishedName} -> ${relativePath}`).to.equal(true);
      expect(statSync(source).size, `${publishedName} is empty`).to.be.greaterThan(0);
    }
  });

  it('constructs the IronCalc backend lazily and evaluates a workbook formula', async function () {
    this.timeout(10_000);
    const wasmSource = Uint8Array.from(readFileSync(ironCalcWasmPath));
    const factory = createDocBlocksCalcEngineFactory({ wasmSource });
    const engine = await factory({});
    try {
      await engine.loadWorkbook({
        sheets: [{ name: 'Sheet1', cells: [[{ value: 7 }]] }],
      });
      expect(await engine.evaluateFormula('A1*6', { sheet: 'Sheet1', row: 0, col: 1 })).to.equal(
        42,
      );
      expect(engine.capabilities.dynamicArrays).to.equal(true);
    } finally {
      engine.dispose();
    }
  });
});
