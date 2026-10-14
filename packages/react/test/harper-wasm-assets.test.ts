import { expect } from 'chai';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'vite';
import {
  harperWasmPlugin,
  HARPER_PUBLISHED_FILES,
  HARPER_WASM_FILE_NAME,
} from '../../../scripts/vite-harper-wasm.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const harperDir = path.join(repoRoot, 'node_modules', 'harper.js');

/**
 * Every surface serves the proofing engine from its own origin, so a file
 * that quietly stops being published does not fail a build — it degrades the
 * engine at runtime, in the one place nobody is watching. Pin the set.
 */
describe('harper engine assets', () => {
  it('resolves linked importers to the host glue that matches the published WASM', async () => {
    const sibling = await mkdtemp(path.join(tmpdir(), 'docblocks-linked-harper-'));
    const otherPackage = path.join(sibling, 'node_modules', 'harper.js');
    await mkdir(otherPackage, { recursive: true });
    await writeFile(
      path.join(otherPackage, 'package.json'),
      JSON.stringify({
        name: 'harper.js',
        version: '0.0.0',
        type: 'module',
        exports: './incompatible.js',
      }),
    );
    await writeFile(
      path.join(otherPackage, 'incompatible.js'),
      'export const incompatible = true;',
    );
    const server = await createServer({
      root: repoRoot,
      configFile: false,
      plugins: [harperWasmPlugin()],
      server: { middlewareMode: true },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    try {
      const resolved = await server.pluginContainer.resolveId(
        'harper.js',
        path.join(sibling, 'editor.js'),
      );
      expect(resolved?.id.replace(/\\/g, '/')).to.equal(
        path.join(harperDir, 'dist', 'index.js').replace(/\\/g, '/'),
      );
    } finally {
      await server.close();
      await rm(sibling, { recursive: true, force: true });
    }
  });

  it('publishes both binaries and the license', () => {
    expect([...HARPER_PUBLISHED_FILES.keys()]).to.have.members([
      'harper_wasm_bg.wasm',
      'harper_wasm_slim_bg.wasm',
      'LICENSE.txt',
    ]);
  });

  it('resolves every published file inside the installed package', () => {
    for (const [publishedName, relativePath] of HARPER_PUBLISHED_FILES) {
      const source = path.join(harperDir, relativePath);
      expect(existsSync(source), `${publishedName} -> ${relativePath}`).to.equal(true);
      expect(statSync(source).size, `${publishedName} is empty`).to.be.greaterThan(0);
    }
  });

  it('names the full binary exactly as harper expects', () => {
    // harper derives the slim sibling by substituting this file name in the
    // URL the host supplies. Rename or hash it and the engine silently loads
    // only half of itself.
    expect(HARPER_WASM_FILE_NAME).to.equal('harper_wasm_bg.wasm');
    expect(HARPER_PUBLISHED_FILES.has(HARPER_WASM_FILE_NAME)).to.equal(true);
    expect(HARPER_PUBLISHED_FILES.has(HARPER_WASM_FILE_NAME.replace('_bg', '_slim_bg'))).to.equal(
      true,
    );
  });

  it('is licensed Apache-2.0 and ships the text that requires', () => {
    const manifest = path.join(harperDir, 'package.json');
    expect(existsSync(manifest)).to.equal(true);
    const license = HARPER_PUBLISHED_FILES.get('LICENSE.txt');
    expect(license).to.equal('LICENSE');
  });
});
