import { expect } from 'chai';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  peImports,
  verifyVcRuntimeCoverage,
  VC_RUNTIME_DLL,
} = require('../scripts/vc-runtime-coverage.cjs');
const { REQUIRED_DLLS, OPTIONAL_DLLS } = require('../scripts/stage-vc-runtime.cjs');

// onnxruntime-node ships every platform's binaries, so these exist on any CI host.
const onnxBin = path.join(
  path.dirname(require.resolve('onnxruntime-node/package.json')),
  'bin',
  'napi-v6',
  'win32',
);
const onnxRuntime = (arch: string) => path.join(onnxBin, arch, 'onnxruntime.dll');

describe('Visual C++ runtime coverage', () => {
  for (const arch of ['x64', 'arm64']) {
    it(`stages every runtime DLL ONNX Runtime ${arch} imports`, async () => {
      const imports: string[] = await peImports(onnxRuntime(arch));
      // Narration failed on clean Windows when this one was not staged.
      expect(imports.map((name) => name.toLowerCase())).to.include('msvcp140_1.dll');
      const staged = new Set<string>([...REQUIRED_DLLS, ...OPTIONAL_DLLS]);
      const unstaged = imports
        .map((name) => name.toLowerCase())
        .filter((name) => VC_RUNTIME_DLL.test(name) && !staged.has(name));
      expect(unstaged).to.deep.equal([]);
    });
  }

  it('reads delay-load imports too', async () => {
    expect(await peImports(onnxRuntime('x64'))).to.include('DirectML.dll');
  });

  describe('in a packaged app', () => {
    let app: string;
    let runtime: string;
    beforeEach(async () => {
      app = await mkdtemp(path.join(os.tmpdir(), 'docblocks-vc-coverage-'));
      runtime = path.join(app, 'resources', 'vc-runtime');
      const engine = path.join(app, 'resources', 'app.asar.unpacked', 'onnxruntime');
      await mkdir(runtime, { recursive: true });
      await mkdir(engine, { recursive: true });
      await copyFile(onnxRuntime('x64'), path.join(engine, 'onnxruntime.dll'));
      // A data file with a binary extension is not a PE image and is ignored.
      await writeFile(path.join(engine, 'notes.dll'), 'not a PE file');
    });
    afterEach(async () => {
      await rm(app, { recursive: true, force: true });
    });

    async function stage(dlls: readonly string[]): Promise<void> {
      for (const dll of dlls) await writeFile(path.join(runtime, dll), dll);
    }

    it('names each missing runtime DLL and its importer', async () => {
      await stage(['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']);
      try {
        await verifyVcRuntimeCoverage({ appOutDir: app, runtimeDir: runtime, required: true });
        expect.fail('Expected the missing runtime DLL to fail packaging');
      } catch (error) {
        const message = (error as Error).message;
        expect(message).to.contain('msvcp140_1.dll');
        expect(message).to.contain(
          path.join('app.asar.unpacked', 'onnxruntime', 'onnxruntime.dll'),
        );
      }
    });

    it('passes when the staged runtime covers every import', async () => {
      await stage([...REQUIRED_DLLS, ...OPTIONAL_DLLS]);
      expect(
        await verifyVcRuntimeCoverage({ appOutDir: app, runtimeDir: runtime, required: true }),
      ).to.deep.equal({ binariesChecked: 1, skipped: false });
    });

    it('skips an unstaged local build unless the runtime is required', async () => {
      expect(
        await verifyVcRuntimeCoverage({ appOutDir: app, runtimeDir: runtime, required: false }),
      ).to.deep.equal({ binariesChecked: 0, skipped: true });
      try {
        await verifyVcRuntimeCoverage({ appOutDir: app, runtimeDir: runtime, required: true });
        expect.fail('Expected a required but unstaged runtime to fail');
      } catch (error) {
        expect((error as Error).message).to.contain('No Visual C++ runtime was staged');
      }
    });
  });
});
