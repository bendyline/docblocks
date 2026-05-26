import { expect } from 'chai';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runBuild } from '../src/commands/build.js';
import { resolveServeTarget, startPreviewServer } from '../src/commands/serve.js';
import { getPackageVersion } from '../src/version.js';

describe('CLI build and serve commands', () => {
  let tempRoot = '';

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'docblocks-cli-'));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('builds markdown files into rendered HTML', async () => {
    const inputDir = path.join(tempRoot, 'docs');
    const outputDir = path.join(tempRoot, 'dist');
    await mkdir(path.join(inputDir, 'nested'), { recursive: true });
    await writeFile(path.join(inputDir, 'index.md'), '# Hello\n\nWorld', 'utf-8');
    await writeFile(path.join(inputDir, 'nested', 'page.markdown'), '## Nested', 'utf-8');

    const result = await runBuild({ input: inputDir, output: outputDir });
    const html = await readFile(path.join(outputDir, 'index.html'), 'utf-8');

    expect(result.builtFiles).to.have.length(2);
    expect(html.toLowerCase()).to.contain('<!doctype html>');
    expect(html).to.contain('Hello');
    expect(await readFile(path.join(outputDir, 'nested', 'page.html'), 'utf-8')).to.contain(
      'Nested',
    );
  });

  it('serves markdown previews as HTML and blocks traversal', async () => {
    const inputDir = path.join(tempRoot, 'docs');
    await mkdir(inputDir, { recursive: true });
    await writeFile(path.join(inputDir, 'index.md'), '# Preview', 'utf-8');

    const preview = await startPreviewServer({ dir: inputDir, port: 0 });
    try {
      const response = await fetch(`${preview.url}index.md`);
      const html = await response.text();

      expect(response.status).to.equal(200);
      expect(response.headers.get('content-type')).to.contain('text/html');
      expect(html).to.contain('Preview');
      expect(await resolveServeTarget(inputDir, '/%2e%2e/secret.md')).to.deep.equal({
        kind: 'forbidden',
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        preview.server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  });

  it('reads the CLI package version from package metadata', () => {
    expect(getPackageVersion()).to.match(/^\d+\.\d+\.\d+/);
    expect(getPackageVersion()).not.to.equal('0.1.0');
  });
});
