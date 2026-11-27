import { expect } from 'chai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { squisqMonacoDeepImports } from '../../../scripts/vite-squisq-monaco-deps.js';

describe('squisqMonacoDeepImports', () => {
  let root: string;
  let dist: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'docblocks-squisq-monaco-'));
    dist = path.join(root, 'node_modules', '@bendyline', 'squisq-editor-react', 'dist');
    fs.mkdirSync(path.join(dist, 'shell'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists every deep Monaco module the editor build imports, once and sorted', () => {
    fs.writeFileSync(
      path.join(dist, 'monaco.js'),
      [
        'export * from "monaco-editor/esm/vs/editor/editor.api.js";',
        'import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";',
        "const go = () => import('monaco-editor/esm/vs/basic-languages/go/go.contribution.js');",
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(dist, 'shell', 'index.js'),
      'import "monaco-editor/esm/vs/editor/contrib/find/browser/findController.js";\n',
    );

    expect(squisqMonacoDeepImports(root)).to.deep.equal([
      'monaco-editor/esm/vs/basic-languages/go/go.contribution.js',
      'monaco-editor/esm/vs/editor/contrib/find/browser/findController.js',
      'monaco-editor/esm/vs/editor/editor.api.js',
    ]);
  });

  it('skips worker imports, declarations and source maps', () => {
    fs.writeFileSync(
      path.join(dist, 'workers.js'),
      'import Worker from "monaco-editor/esm/vs/editor/editor.worker.js?worker";\n',
    );
    fs.writeFileSync(
      path.join(dist, 'monaco.d.ts'),
      'export * from "monaco-editor/esm/vs/editor/editor.api.js";\n',
    );
    fs.writeFileSync(
      path.join(dist, 'monaco.js.map'),
      '{"sourcesContent":["import \\"monaco-editor/esm/vs/editor/editor.api.js\\""]}\n',
    );

    expect(squisqMonacoDeepImports(root)).to.deep.equal([]);
  });

  it('is empty before the editor package is installed', () => {
    fs.rmSync(path.join(root, 'node_modules'), { recursive: true, force: true });
    expect(squisqMonacoDeepImports(root)).to.deep.equal([]);
  });
});
