import { expect } from 'chai';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { get } from 'node:http';
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
      const address = preview.server.address();
      expect(preview.host).to.equal('127.0.0.1');
      expect(address).to.be.an('object');
      if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
      expect(address.address).to.equal('127.0.0.1');
      const response = await requestPreview(`${preview.url}index.md`);
      const html = response.body.toString('utf8');

      expect(response.status).to.equal(200);
      expect(response.contentType).to.contain('text/html');
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

  it('requires explicit network exposure and rejects physical symlink escapes', async () => {
    const inputDir = path.join(tempRoot, 'docs');
    const outsideDir = path.join(tempRoot, 'outside');
    await mkdir(inputDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(path.join(outsideDir, 'secret.txt'), 'secret', 'utf-8');
    await symlink(
      outsideDir,
      path.join(inputDir, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(await resolveServeTarget(inputDir, '/linked/secret.txt')).to.deep.equal({
      kind: 'forbidden',
    });

    let error: unknown;
    try {
      await startPreviewServer({ dir: inputDir, port: 0, host: '0.0.0.0' });
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.contain('--allow-network');
  });

  it('rejects files beyond the configured request budget', async () => {
    const inputDir = path.join(tempRoot, 'docs');
    await mkdir(inputDir, { recursive: true });
    await writeFile(path.join(inputDir, 'large.md'), '12345', 'utf-8');
    expect(await resolveServeTarget(inputDir, '/large.md', 4)).to.deep.equal({
      kind: 'too-large',
    });
  });

  it('reads the CLI package version from package metadata', () => {
    expect(getPackageVersion()).to.match(/^\d+\.\d+\.\d+/);
    expect(getPackageVersion()).not.to.equal('0.1.0');
  });
});

function requestPreview(
  url: string,
): Promise<{ status: number; contentType: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = get(url, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          contentType: String(response.headers['content-type'] ?? ''),
          body: Buffer.concat(chunks),
        }),
      );
    });
    request.on('error', reject);
  });
}
