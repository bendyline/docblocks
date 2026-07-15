import { expect } from 'chai';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { runBuild } from '../src/commands/build.js';
import { renderMarkdownHtml } from '../src/render-html.js';
import {
  isAllowedPreviewRequestAuthority,
  resolveServeTarget,
  startPreviewServer,
} from '../src/commands/serve.js';
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
    await mkdir(path.join(inputDir, '.assets'), { recursive: true });
    const hiddenBuildAsset = 'static-build-hidden-asset';
    await writeFile(
      path.join(inputDir, 'index.md'),
      '# Hello\n\nWorld\n\n![Build asset](.assets/diagram.png)',
      'utf-8',
    );
    await writeFile(path.join(inputDir, '.assets', 'diagram.png'), hiddenBuildAsset, 'utf-8');
    await writeFile(path.join(inputDir, 'nested', 'page.markdown'), '## Nested', 'utf-8');

    const result = await runBuild({ input: inputDir, output: outputDir });
    const html = await readFile(path.join(outputDir, 'index.html'), 'utf-8');

    expect(result.builtFiles).to.have.length(2);
    expect(html.toLowerCase()).to.contain('<!doctype html>');
    expect(html).to.contain('Hello');
    expect(html).to.contain(Buffer.from(hiddenBuildAsset).toString('base64'));
    expect(await readFile(path.join(outputDir, 'nested', 'page.html'), 'utf-8')).to.contain(
      'Nested',
    );
  });

  it('keeps authored HTML inert in generated standalone output', async () => {
    const html = await renderMarkdownHtml(
      [
        '<div onload="DOCBLOCKS_XSS_SENTINEL">',
        '<img src="x.png" onerror="DOCBLOCKS_XSS_SENTINEL">',
        '<script>DOCBLOCKS_XSS_SENTINEL</script>',
        '<svg onload="DOCBLOCKS_XSS_SENTINEL"><script>sentinel</script></svg>',
        '</div>',
        '',
        '[unsafe](javascript:DOCBLOCKS_XSS_SENTINEL)',
        '',
        '<iframe src="https://example.com/track"></iframe>',
      ].join('\n'),
      { title: 'Adversarial HTML' },
    );

    // Rendered HTML must be inert. The standalone player intentionally embeds
    // an escaped source document for playback, so sentinel text may remain in
    // JSON, but never in executable markup or a live URL attribute.
    expect(html).not.to.match(/<[^>]+\son(?:error|load)=["'][^"']*DOCBLOCKS_XSS_SENTINEL/iu);
    expect(html).not.to.contain('<script>DOCBLOCKS_XSS_SENTINEL');
    expect(html.toLowerCase()).not.to.contain('href="javascript:');
    expect(html.toLowerCase()).not.to.contain('<iframe src="https://example.com/track"');
    expect(html.toLowerCase()).not.to.contain('<svg onload="');
  });

  it('bounds build traversal and distinguishes a non-directory input', async () => {
    const inputDir = path.join(tempRoot, 'docs');
    const outputDir = path.join(tempRoot, 'dist');
    await mkdir(inputDir, { recursive: true });
    await writeFile(path.join(inputDir, 'one.md'), '# One', 'utf8');
    await writeFile(path.join(inputDir, 'two.md'), '# Two', 'utf8');

    const budgetFailure = await captureFailure(
      runBuild({ input: inputDir, output: outputDir, maxEntries: 1 }),
    );
    expect(budgetFailure).to.be.instanceOf(Error);
    expect((budgetFailure as Error).message).to.include('exceeded 1 filesystem entries');

    const fileInput = path.join(tempRoot, 'not-a-directory.md');
    await writeFile(fileInput, '# File', 'utf8');
    const kindFailure = await captureFailure(runBuild({ input: fileInput, output: outputDir }));
    expect(kindFailure).to.be.instanceOf(Error);
    expect((kindFailure as Error).message).to.include('Input is not a directory');
  });

  it('does not follow directory symlinks or junction cycles during build traversal', async () => {
    const inputDir = path.join(tempRoot, 'docs');
    const outputDir = path.join(tempRoot, 'dist');
    await mkdir(inputDir, { recursive: true });
    await writeFile(path.join(inputDir, 'index.md'), '# Root', 'utf8');
    await symlink(
      inputDir,
      path.join(inputDir, 'cycle'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const result = await runBuild({ input: inputDir, output: outputDir });
    expect(result.builtFiles).to.deep.equal([path.join(outputDir, 'index.html')]);
  });

  it('skips missing images but surfaces non-missing embedded-asset failures', async () => {
    const inputDir = path.join(tempRoot, 'docs');
    const sourcePath = path.join(inputDir, 'index.md');
    await mkdir(inputDir, { recursive: true });
    await writeFile(sourcePath, '# Assets\n\n![missing](missing.png)', 'utf-8');

    const missingHtml = await renderMarkdownHtml('![missing](missing.png)', {
      title: 'Missing asset',
      sourcePath,
      assetRoot: inputDir,
    });
    expect(missingHtml).to.contain('missing.png');

    await writeFile(path.join(inputDir, 'present.png'), 'image', 'utf-8');
    const failure = new Error('preview policy unavailable');
    let caught: unknown;
    try {
      await renderMarkdownHtml('![present](present.png)', {
        title: 'Failed policy',
        sourcePath,
        assetRoot: inputDir,
        allowReferencedAsset: () => {
          throw failure;
        },
      });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.include('Failed to embed referenced image');
    expect((caught as Error & { cause?: unknown }).cause).to.equal(failure);
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
    await writeFile(path.join(outsideDir, 'secret.png'), 'secret', 'utf-8');
    await symlink(
      outsideDir,
      path.join(inputDir, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(await resolveServeTarget(inputDir, '/linked/secret.png')).to.deep.equal({
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

    const invalidLoopback = await captureFailure(
      startPreviewServer({ dir: inputDir, port: 0, host: '127.999.0.1' }),
    );
    expect(invalidLoopback).to.be.instanceOf(Error);
    expect((invalidLoopback as Error).message).to.contain('--allow-network');
  });

  it('rejects files beyond the configured request budget', async () => {
    const inputDir = path.join(tempRoot, 'docs');
    await mkdir(inputDir, { recursive: true });
    await writeFile(path.join(inputDir, 'large.md'), '12345', 'utf-8');
    expect(await resolveServeTarget(inputDir, '/large.md', 4)).to.deep.equal({
      kind: 'too-large',
    });
  });

  it('serves only preview assets and denies hidden or sensitive paths', async () => {
    const inputDir = path.join(tempRoot, 'docs');
    await mkdir(path.join(inputDir, '.git'), { recursive: true });
    await writeFile(path.join(inputDir, 'diagram.png'), 'png', 'utf-8');
    await writeFile(path.join(inputDir, 'notes.txt'), 'private notes', 'utf-8');
    await writeFile(path.join(inputDir, 'client.pem'), 'private key', 'utf-8');
    await writeFile(path.join(inputDir, '.env'), 'TOKEN=secret', 'utf-8');
    await writeFile(path.join(inputDir, '.git', 'config'), 'secret', 'utf-8');

    expect(await resolveServeTarget(inputDir, '/diagram.png')).to.include({ kind: 'file' });
    expect(await resolveServeTarget(inputDir, '/notes.txt')).to.deep.equal({ kind: 'forbidden' });
    expect(await resolveServeTarget(inputDir, '/client.pem')).to.deep.equal({ kind: 'forbidden' });
    expect(await resolveServeTarget(inputDir, '/.env')).to.deep.equal({ kind: 'forbidden' });
    expect(await resolveServeTarget(inputDir, '/.git/config')).to.deep.equal({
      kind: 'forbidden',
    });
  });

  it('applies the preview policy to embedded images as well as direct routes', async () => {
    const inputDir = path.join(tempRoot, 'docs');
    await mkdir(inputDir, { recursive: true });
    const imageBytes = 'ordinary-preview-image';
    const envBytes = 'EMBEDDED_ENV_SECRET_3817';
    const pemBytes = 'EMBEDDED_PEM_SECRET_4928';
    const textBytes = 'EMBEDDED_TEXT_SECRET_5039';
    await writeFile(
      path.join(inputDir, 'index.md'),
      [
        '# Assets',
        '',
        '![normal](diagram.png)',
        '![environment](.env)',
        '![certificate](client.pem)',
        '![arbitrary text](notes.txt)',
      ].join('\n'),
      'utf-8',
    );
    await writeFile(path.join(inputDir, 'diagram.png'), imageBytes, 'utf-8');
    await writeFile(path.join(inputDir, '.env'), envBytes, 'utf-8');
    await writeFile(path.join(inputDir, 'client.pem'), pemBytes, 'utf-8');
    await writeFile(path.join(inputDir, 'notes.txt'), textBytes, 'utf-8');

    const preview = await startPreviewServer({ dir: inputDir, port: 0 });
    try {
      const response = await requestPreview(`${preview.url}index.md`);
      const html = response.body.toString('utf8');
      expect(response.status).to.equal(200);
      expect(html).to.contain(Buffer.from(imageBytes).toString('base64'));
      expect(html).not.to.contain(envBytes);
      expect(html).not.to.contain(pemBytes);
      expect(html).not.to.contain(textBytes);
      expect(html).not.to.contain(Buffer.from(envBytes).toString('base64'));
      expect(html).not.to.contain(Buffer.from(pemBytes).toString('base64'));
      expect(html).not.to.contain(Buffer.from(textBytes).toString('base64'));
    } finally {
      await closeServer(preview.server);
    }
  });

  it('rejects a visible symlink that resolves through a hidden directory', async () => {
    const inputDir = path.join(tempRoot, 'docs');
    const hiddenDir = path.join(inputDir, '.private');
    await mkdir(hiddenDir, { recursive: true });
    await writeFile(path.join(hiddenDir, 'secret.png'), 'hidden-image-secret', 'utf-8');
    await symlink(
      hiddenDir,
      path.join(inputDir, 'images'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(await resolveServeTarget(inputDir, '/images/secret.png')).to.deep.equal({
      kind: 'forbidden',
    });
  });

  it('rejects DNS-rebinding Host headers and validates IPv6 authority formatting', async () => {
    const inputDir = path.join(tempRoot, 'docs');
    await mkdir(inputDir, { recursive: true });
    await writeFile(path.join(inputDir, 'index.md'), '# Preview', 'utf-8');

    const preview = await startPreviewServer({ dir: inputDir, port: 0 });
    try {
      const port = Number(new URL(preview.url).port);
      const forged = await requestPreview(
        `${preview.url}index.md`,
        'GET',
        `127.0.0.1.attacker.invalid:${port}`,
      );
      const forgedHead = await requestPreview(
        `${preview.url}index.md`,
        'HEAD',
        `attacker.invalid:${port}`,
      );
      expect(forged.status).to.equal(421);
      expect(forged.body.toString('utf8')).to.equal('Misdirected request\n');
      expect(forgedHead.status).to.equal(421);
      expect(forgedHead.body).to.have.length(0);
    } finally {
      await closeServer(preview.server);
    }

    expect(isAllowedPreviewRequestAuthority('[::1]:4312', '::1', 4312)).to.equal(true);
    expect(isAllowedPreviewRequestAuthority('::1:4312', '::1', 4312)).to.equal(false);
    expect(isAllowedPreviewRequestAuthority('[::1]:4313', '::1', 4312)).to.equal(false);
    expect(isAllowedPreviewRequestAuthority('127.0.0.1:4312', '127.0.0.1', 4312)).to.equal(true);
  });

  it('does not send response bodies for HEAD successes or errors', async () => {
    const inputDir = path.join(tempRoot, 'docs');
    await mkdir(inputDir, { recursive: true });
    await writeFile(path.join(inputDir, 'index.md'), '# Preview', 'utf-8');

    const preview = await startPreviewServer({ dir: inputDir, port: 0 });
    try {
      const success = await requestPreview(`${preview.url}index.md`, 'HEAD');
      const missing = await requestPreview(`${preview.url}missing.md`, 'HEAD');
      expect(success.status).to.equal(200);
      expect(success.body).to.have.length(0);
      expect(missing.status).to.equal(404);
      expect(missing.body).to.have.length(0);
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

function requestPreview(
  url: string,
  method = 'GET',
  hostHeader?: string,
): Promise<{ status: number; contentType: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      url,
      { method, headers: hostHeader ? { host: hostHeader } : undefined },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            contentType: String(response.headers['content-type'] ?? ''),
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

function closeServer(server: import('node:http').Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function captureFailure(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
    return null;
  } catch (error: unknown) {
    return error;
  }
}
