import { expect } from 'chai';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runBuild } from '../src/commands/build.js';
import { startPreviewServer } from '../src/commands/serve.js';
import { runWorkspaceRefresh } from '../src/index.js';
import { renderMarkdownHtml } from '../src/render-html.js';

const execFileAsync = promisify(execFile);
const CLI_ENTRY = fileURLToPath(new URL('../src/bin.ts', import.meta.url));

const CATALOG_SETTINGS = {
  version: 1,
  documents: { defaultTheme: 'warm-earth' },
  catalog: { title: 'Field Notes', html: { enabled: true }, json: { enabled: true } },
};

describe('docblocks workspace refresh', function () {
  this.timeout(30_000);
  let workspace = '';

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'docblocks-workspace-refresh-'));
    await mkdir(path.join(workspace, 'notes'), { recursive: true });
    await writeFile(
      path.join(workspace, 'alpha.md'),
      '---\ntitle: Alpha Story\n---\n\n# Alpha\n\nAlpha body.\n',
    );
    await writeFile(path.join(workspace, 'notes', 'beta.md'), '# Beta\n\nBeta body.\n');
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('writes enabled outputs once and leaves unchanged bytes alone', async () => {
    await writeSettings(workspace, CATALOG_SETTINGS);
    // Imported HTML title metadata takes precedence over the first body heading.
    await writeFile(
      path.join(workspace, 'page.html'),
      '<html><head><title>Page</title></head><body><h1>Rendered Page</h1><p>Text.</p></body></html>',
    );

    const first = await runWorkspaceRefresh({ dir: workspace });
    expect(first.status).to.equal('refreshed');
    expect(first.documentCount).to.equal(3);
    expect(
      first.outputs.map(({ kind, path: output, status }) => [kind, output, status]),
    ).to.deep.equal([
      ['json', 'catalog.json', 'written'],
      ['html', 'index.html', 'written'],
    ]);

    const catalog = JSON.parse(await readFile(path.join(workspace, 'catalog.json'), 'utf8')) as {
      generator: string;
      title: string;
      documents: Array<{ path: string; title: string }>;
    };
    expect(catalog.generator).to.equal('docblocks-workspace-catalog');
    expect(catalog.title).to.equal('Field Notes');
    expect(catalog.documents.map((entry) => [entry.path, entry.title])).to.deep.equal([
      ['alpha.md', 'Alpha Story'],
      ['notes/beta.md', 'Beta'],
      ['page.html', 'Page'],
    ]);
    const html = await readFile(path.join(workspace, 'index.html'), 'utf8');
    expect(html).to.match(/^<!DOCTYPE html>\n<!-- docblocks-workspace-catalog v1 inputs=sha256:/i);
    expect(html).to.include('Field Notes');
    expect(html).to.include('notes/beta.md');
    expect(html).to.not.match(/<script/i);

    const before = await Promise.all(
      ['catalog.json', 'index.html'].map((name) => stat(path.join(workspace, name))),
    );
    const second = await runWorkspaceRefresh({ dir: workspace });
    expect(second.outputs.map((output) => output.status)).to.deep.equal(['unchanged', 'unchanged']);
    const forced = await runWorkspaceRefresh({ dir: workspace, force: true });
    expect(forced.outputs.map((output) => output.status)).to.deep.equal(['unchanged', 'unchanged']);
    const after = await Promise.all(
      ['catalog.json', 'index.html'].map((name) => stat(path.join(workspace, name))),
    );
    expect(after.map((info) => [info.ino, info.mtimeMs])).to.deep.equal(
      before.map((info) => [info.ino, info.mtimeMs]),
    );
    expect((await readdir(workspace)).sort()).to.deep.equal(
      ['.docblocks', 'alpha.md', 'catalog.json', 'index.html', 'notes', 'page.html'].sort(),
    );
  });

  it('reports what a dry run would write without writing it', async () => {
    await writeSettings(workspace, CATALOG_SETTINGS);

    const result = await runWorkspaceRefresh({ dir: workspace, dryRun: true });
    expect(result.dryRun).to.equal(true);
    expect(result.outputs.map((output) => output.status)).to.deep.equal([
      'would-write',
      'would-write',
    ]);
    expect((await readdir(workspace)).sort()).to.deep.equal(['.docblocks', 'alpha.md', 'notes']);

    const cli = await runCli(['workspace', 'refresh', workspace, '--dry-run']);
    expect(cli.code).to.equal(0);
    expect(cli.stderr).to.include('would write catalog.json');
    expect(cli.stderr).to.include('would write index.html');
    expect((await readdir(workspace)).sort()).to.deep.equal(['.docblocks', 'alpha.md', 'notes']);
  });

  it('refuses to replace a hand-written page and exits 1', async () => {
    await writeSettings(workspace, CATALOG_SETTINGS);
    await writeFile(path.join(workspace, 'index.html'), '<html><body>Mine</body></html>\n');

    const result = await runWorkspaceRefresh({ dir: workspace });
    const html = result.outputs.find((output) => output.kind === 'html');
    expect(html?.status).to.equal('blocked');
    expect(html?.message).to.include('was not created by DocBlocks');
    expect(await readFile(path.join(workspace, 'index.html'), 'utf8')).to.equal(
      '<html><body>Mine</body></html>\n',
    );

    const cli = await runCli(['workspace', 'refresh', workspace]);
    expect(cli.code).to.equal(1);
    expect(cli.stderr).to.include('unchanged catalog.json');
    expect(cli.stderr).to.match(/blocked index\.html: index\.html already exists/);
    expect(await readFile(path.join(workspace, 'index.html'), 'utf8')).to.equal(
      '<html><body>Mine</body></html>\n',
    );
  });

  it('succeeds without writing when the workspace has no settings or enables nothing', async () => {
    expect((await runWorkspaceRefresh({ dir: workspace })).status).to.equal('missing');
    const cli = await runCli(['workspace', 'refresh', workspace]);
    expect(cli.code).to.equal(0);
    expect(cli.stderr).to.include('No workspace settings found');

    await writeSettings(workspace, { version: 1, documents: { defaultTheme: 'bold' } });
    expect((await runWorkspaceRefresh({ dir: workspace })).status).to.equal('disabled');
    expect((await readdir(workspace)).sort()).to.deep.equal(['.docblocks', 'alpha.md', 'notes']);
  });

  it('fails with the parser message for invalid or newer settings', async () => {
    await writeSettings(workspace, { version: 1, catalog: { sort: 'size' } });
    const invalid = await captureError(runWorkspaceRefresh({ dir: workspace }));
    expect(invalid).to.be.instanceOf(Error);
    expect((invalid as Error).message).to.include('catalog.sort must be one of');

    const cli = await runCli(['workspace', 'refresh', workspace]);
    expect(cli.code).to.equal(1);
    expect(cli.stderr).to.include('Error: .docblocks/workspace.json: catalog.sort must be one of');

    await writeSettings(workspace, { version: 2 });
    const newer = await captureError(runWorkspaceRefresh({ dir: workspace }));
    expect((newer as Error).message).to.include('newer version of DocBlocks');
    expect((await readdir(workspace)).sort()).to.deep.equal(['.docblocks', 'alpha.md', 'notes']);
  });
});

describe('workspace default theme in build and serve', function () {
  this.timeout(30_000);
  let tempRoot = '';
  let input = '';

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'docblocks-workspace-theme-'));
    input = path.join(tempRoot, 'docs');
    await mkdir(input, { recursive: true });
    await writeFile(path.join(input, 'plain.md'), '# Plain\n\nNo theme of its own.\n');
    await writeFile(
      path.join(input, 'themed.md'),
      '---\nsquisq-theme: documentary\n---\n\n# Themed\n\nAuthored theme.\n',
    );
    await writeSettings(input, { version: 1, documents: { defaultTheme: 'warm-earth' } });
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  async function build(
    options: { theme?: string; ignoreWorkspaceSettings?: boolean } = {},
  ): Promise<{ plain: string; themed: string; warnings: string[] }> {
    const output = path.join(tempRoot, 'dist');
    const warnings: string[] = [];
    await runBuild({ input, output, ...options, onWarning: (message) => warnings.push(message) });
    return {
      plain: await readFile(path.join(output, 'plain.html'), 'utf8'),
      themed: await readFile(path.join(output, 'themed.html'), 'utf8'),
      warnings,
    };
  }

  it('applies the workspace default only to documents that name no theme', async () => {
    const { plain, themed, warnings } = await build();
    expect(plain).to.include('"themeId":"warm-earth"');
    expect(themed).to.include('"themeId":"documentary"');
    expect(themed).to.not.include('"themeId":"warm-earth"');
    expect(warnings).to.deep.equal([]);
  });

  it('lets --theme win without reading workspace settings', async () => {
    await writeFile(path.join(input, '.docblocks', 'workspace.json'), '{ not json');
    const { plain, themed, warnings } = await build({ theme: 'bold' });
    expect(plain).to.include('"themeId":"bold"');
    expect(themed).to.include('"themeId":"bold"');
    expect(warnings).to.deep.equal([]);
  });

  it('ignores workspace settings when asked', async () => {
    const { plain, themed } = await build({ ignoreWorkspaceSettings: true });
    expect(plain).to.not.include('"themeId":"warm-earth"');
    expect(themed).to.include('"themeId":"documentary"');

    const cli = await runCli([
      'build',
      '--input',
      input,
      '--output',
      path.join(tempRoot, 'cli-dist'),
      '--ignore-workspace-settings',
    ]);
    expect(cli.code).to.equal(0);
    expect(await readFile(path.join(tempRoot, 'cli-dist', 'plain.html'), 'utf8')).to.not.include(
      '"themeId":"warm-earth"',
    );
  });

  it('warns and builds without the default when settings are unusable', async () => {
    await writeFile(path.join(input, '.docblocks', 'workspace.json'), '{ not json');
    const invalid = await build();
    expect(invalid.plain).to.not.include('"themeId":"warm-earth"');
    expect(invalid.warnings).to.have.length(1);
    expect(invalid.warnings[0]).to.include('Ignoring workspace settings');
    expect(invalid.warnings[0]).to.include('not valid JSON');

    await writeSettings(input, { version: 1, documents: { defaultTheme: 'no-such-theme' } });
    const unknown = await build();
    expect(unknown.plain).to.not.include('no-such-theme');
    expect(unknown.warnings).to.deep.equal([
      'Ignoring workspace default theme "no-such-theme" from .docblocks/workspace.json: it is not a known theme.',
    ]);
  });

  it('warns instead of failing on an unknown fallback theme', async () => {
    const warnings: string[] = [];
    const html = await renderMarkdownHtml('# Plain\n', {
      title: 'Plain',
      fallbackThemeId: 'no-such-theme',
      onWarning: (message) => warnings.push(message),
    });
    expect(html).to.not.include('no-such-theme');
    expect(warnings).to.have.length(1);
    expect(warnings[0]).to.include('no-such-theme');
  });

  it('previews with the current workspace default unless --theme or the opt-out applies', async () => {
    const warnings: string[] = [];
    const preview = await startPreviewServer({
      dir: input,
      port: 0,
      onWarning: (message) => warnings.push(message),
    });
    try {
      expect(await fetchText(`${preview.url}plain.md`)).to.include('"themeId":"warm-earth"');
      expect(await fetchText(`${preview.url}themed.md`)).to.include('"themeId":"documentary"');

      // The settings file is re-read per preview, so an edit applies on refresh.
      await writeSettings(input, { version: 1, documents: { defaultTheme: 'magazine' } });
      expect(await fetchText(`${preview.url}plain.md`)).to.include('"themeId":"magazine"');

      // A repeated problem is reported once, not on every request.
      await writeFile(path.join(input, '.docblocks', 'workspace.json'), '{ not json');
      await fetchText(`${preview.url}plain.md`);
      await fetchText(`${preview.url}plain.md`);
      expect(warnings).to.have.length(1);
      expect(warnings[0]).to.include('Ignoring workspace settings');
    } finally {
      await closeServer(preview.server);
    }

    const optedOut = await startPreviewServer({
      dir: input,
      port: 0,
      ignoreWorkspaceSettings: true,
    });
    try {
      await writeSettings(input, { version: 1, documents: { defaultTheme: 'warm-earth' } });
      expect(await fetchText(`${optedOut.url}plain.md`)).to.not.include('"themeId":"warm-earth"');
    } finally {
      await closeServer(optedOut.server);
    }
  });
});

async function writeSettings(root: string, settings: unknown): Promise<void> {
  await mkdir(path.join(root, '.docblocks'), { recursive: true });
  await writeFile(
    path.join(root, '.docblocks', 'workspace.json'),
    `${JSON.stringify(settings, null, 2)}\n`,
  );
}

async function runCli(
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', CLI_ENTRY, ...args],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    );
    return { code: 0, stdout, stderr };
  } catch (error: unknown) {
    const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    if (typeof failure.code !== 'number') throw error;
    return {
      code: failure.code,
      stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
      stderr: typeof failure.stderr === 'string' ? failure.stderr : '',
    };
  }
}

async function captureError(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
    return null;
  } catch (error: unknown) {
    return error;
  }
}

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode !== 200) reject(new Error(`HTTP ${response.statusCode}: ${body}`));
        else resolve(body);
      });
    });
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
