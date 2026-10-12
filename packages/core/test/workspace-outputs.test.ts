import { expect } from 'chai';
import { stringifyMarkdown, type MarkdownDocument } from '@bendyline/squisq/markdown';
import {
  FsError,
  MemoryFileSystemProviderV2,
  parseWorkspacePath,
  type FileSystemProviderV2,
} from '../src/filesystem/index.js';
import {
  WorkspaceOutputsLimitError,
  createWorkspaceCatalogCache,
  isCatalogRelevantPath,
  isGeneratedCatalogHtml,
  isGeneratedCatalogJson,
  isWorkspaceSettingsPath,
  readCatalogHtmlDigest,
  refreshWorkspaceOutputs,
  relativeCatalogLink,
  type WorkspaceOutputsRenderer,
  type WorkspaceSettings,
} from '../src/workspace-settings/index.js';

let providerCount = 0;
function createProvider(): MemoryFileSystemProviderV2 {
  providerCount += 1;
  return new MemoryFileSystemProviderV2(`outputs-${providerCount}`, 'Outputs');
}

async function write(provider: FileSystemProviderV2, path: string, text: string): Promise<void> {
  await provider.writeFile(parseWorkspacePath(path), new TextEncoder().encode(text), {
    createParents: true,
  });
}

async function read(provider: FileSystemProviderV2, path: string): Promise<string | null> {
  const file = await provider.readFile(parseWorkspacePath(path));
  return file ? new TextDecoder().decode(file.data) : null;
}

/** Deterministic stand-in for squisq-formats' plain HTML renderer. */
const renderer: WorkspaceOutputsRenderer & { calls: number } = {
  calls: 0,
  renderCatalogHtml(document, options) {
    this.calls += 1;
    return `<!DOCTYPE html>\n<html data-theme="${options.themeId ?? ''}"><title>${options.title}</title><body>\n${stringifyMarkdown(document)}</body></html>\n`;
  },
  importHtml(html: string): MarkdownDocument {
    const heading = /<h1>([^<]*)<\/h1>/i.exec(html)?.[1];
    const paragraph = /<p>([^<]*)<\/p>/i.exec(html)?.[1];
    return {
      type: 'document',
      children: [
        ...(heading
          ? [
              {
                type: 'heading' as const,
                depth: 1 as const,
                children: [{ type: 'text' as const, value: heading }],
              },
            ]
          : []),
        ...(paragraph
          ? [
              {
                type: 'paragraph' as const,
                children: [{ type: 'text' as const, value: paragraph }],
              },
            ]
          : []),
      ],
    };
  },
};

const BOTH: WorkspaceSettings = {
  version: 1,
  documents: { defaultTheme: 'warm-earth' },
  catalog: {
    title: 'Articles',
    html: { enabled: true },
    json: { enabled: true },
  },
};

async function seed(provider: FileSystemProviderV2): Promise<void> {
  await write(
    provider,
    'alpha.md',
    '---\ntitle: Alpha Story\ndescription: First one\ntags: [news, local]\ndate: 2026-01-02\n---\n\n# Alpha heading\n\nAlpha body words here.\n\n## Part two\n',
  );
  await write(provider, 'notes/beta.md', '# Beta\r\n\r\nBeta *body*.\r\n');
  await write(provider, 'Battle.html', '<html><body>rendered</body></html>');
  await write(
    provider,
    'Battle_files/battle.md',
    '---\nsquisq-outside-in: 1\nsquisq-theme: gezellig\n---\n\n# Battle of Britain\n\nSummer 1940.\n',
  );
  await write(
    provider,
    'raw.html',
    '<html><head><title>Raw page</title></head><body><h1>Raw</h1><p>Plain html.</p></body></html>',
  );
  await write(provider, 'Report.docx', 'binary');
  await write(provider, '.hidden/secret.md', '# Secret');
  await write(provider, 'node_modules/pkg/readme.md', '# Package');
  await write(provider, 'Battle_files/.versions/battle.2026.md', '# Old');
  await write(provider, 'drafts/wip.md', '# WIP');
}

describe('workspace catalog outputs', () => {
  it('writes nothing when no output is enabled', async () => {
    const provider = createProvider();
    await seed(provider);
    const result = await refreshWorkspaceOutputs(provider, { version: 1 }, renderer);
    expect(result).to.deep.equal({ documentCount: 0, outputs: [] });
    expect(await read(provider, 'index.html')).to.equal(null);
    expect(await read(provider, 'catalog.json')).to.equal(null);
  });

  it('catalogs markdown, outside-in companions, raw HTML and unreadable formats', async () => {
    const provider = createProvider();
    await seed(provider);
    const settings: WorkspaceSettings = {
      ...BOTH,
      catalog: { ...BOTH.catalog, exclude: ['drafts'] },
    };
    const result = await refreshWorkspaceOutputs(provider, settings, renderer);
    expect(result.outputs.map((output) => [output.kind, output.path, output.status])).to.deep.equal(
      [
        ['json', 'catalog.json', 'written'],
        ['html', 'index.html', 'written'],
      ],
    );

    const json = JSON.parse((await read(provider, 'catalog.json'))!);
    expect(json.generator).to.equal('docblocks-workspace-catalog');
    expect(json.title).to.equal('Articles');
    expect(json.documents.map((entry: { path: string }) => entry.path)).to.deep.equal([
      'alpha.md',
      'Battle.html',
      'notes/beta.md',
      'raw.html',
      'Report.docx',
    ]);
    const [alpha, battle, beta, raw, report] = json.documents;
    expect(alpha).to.deep.equal({
      path: 'alpha.md',
      format: 'markdown',
      title: 'Alpha Story',
      description: 'First one',
      date: '2026-01-02',
      tags: ['news', 'local'],
      outline: [
        { level: 1, title: 'Alpha heading' },
        { level: 2, title: 'Part two' },
      ],
      wordCount: 8,
      excerpt: 'Alpha body words here.',
    });
    expect(battle).to.include({
      path: 'Battle.html',
      source: 'Battle_files/battle.md',
      format: 'html',
      title: 'Battle of Britain',
      theme: 'gezellig',
    });
    expect(beta).to.include({ title: 'Beta', excerpt: 'Beta body.' });
    expect(raw).to.include({ format: 'html', title: 'Raw', excerpt: 'Plain html.' });
    expect(report).to.deep.equal({
      path: 'Report.docx',
      format: 'docx',
      title: 'Report',
      outline: [],
      wordCount: 0,
    });
    expect(JSON.stringify(json)).not.to.match(/Secret|Package|WIP|Old/);

    const html = (await read(provider, 'index.html'))!;
    expect(
      html.startsWith('<!DOCTYPE html>\n<!-- docblocks-workspace-catalog v1 inputs=sha256:'),
    ).to.equal(true);
    expect(isGeneratedCatalogHtml(html)).to.equal(true);
    expect(html).to.contain('data-theme="warm-earth"');
    expect(html).to.contain('[Alpha Story](alpha.md)');
    expect(html).to.contain('## notes');
    expect(html).to.contain('[Beta](notes/beta.md)');
  });

  it('is idempotent: a second run writes nothing and renders nothing', async () => {
    const provider = createProvider();
    await seed(provider);
    await refreshWorkspaceOutputs(provider, BOTH, renderer);
    const before = renderer.calls;
    const second = await refreshWorkspaceOutputs(provider, BOTH, renderer);
    expect(second.outputs.map((output) => output.status)).to.deep.equal(['unchanged', 'unchanged']);
    expect(renderer.calls).to.equal(before);
  });

  it('produces byte-identical outputs from identical inputs in separate workspaces', async () => {
    const first = createProvider();
    const second = createProvider();
    await seed(first);
    await seed(second);
    await refreshWorkspaceOutputs(first, BOTH, renderer);
    await refreshWorkspaceOutputs(second, BOTH, renderer, { cache: createWorkspaceCatalogCache() });
    expect(await read(first, 'catalog.json')).to.equal(await read(second, 'catalog.json'));
    expect(await read(first, 'index.html')).to.equal(await read(second, 'index.html'));
  });

  it('updates outputs when a document changes and reuses cached entries otherwise', async () => {
    const provider = createProvider();
    await seed(provider);
    const cache = createWorkspaceCatalogCache();
    await refreshWorkspaceOutputs(provider, BOTH, renderer, { cache });
    const digest = readCatalogHtmlDigest((await read(provider, 'index.html'))!);
    await write(provider, 'notes/beta.md', '# Beta renamed\n');
    const result = await refreshWorkspaceOutputs(provider, BOTH, renderer, { cache });
    expect(result.outputs.map((output) => output.status)).to.deep.equal(['written', 'written']);
    expect(await read(provider, 'catalog.json')).to.contain('Beta renamed');
    expect(readCatalogHtmlDigest((await read(provider, 'index.html'))!)).not.to.equal(digest);
  });

  it('never replaces a file it did not generate', async () => {
    const provider = createProvider();
    await seed(provider);
    await write(provider, 'index.html', '<!DOCTYPE html>\n<p>My own landing page</p>');
    await write(provider, 'catalog.json', '{"mine": true}');
    const result = await refreshWorkspaceOutputs(provider, BOTH, renderer);
    expect(result.outputs.map((output) => output.status)).to.deep.equal(['blocked', 'blocked']);
    expect(await read(provider, 'index.html')).to.equal(
      '<!DOCTYPE html>\n<p>My own landing page</p>',
    );
    expect(await read(provider, 'catalog.json')).to.equal('{"mine": true}');
  });

  it('refuses an HTML output path that is an outside-in document', async () => {
    const provider = createProvider();
    await seed(provider);
    const settings: WorkspaceSettings = {
      version: 1,
      catalog: { html: { enabled: true, path: 'Battle.html' } },
    };
    const result = await refreshWorkspaceOutputs(provider, settings, renderer);
    expect(result.outputs[0]?.status).to.equal('blocked');
  });

  it('does not list its own outputs or orphaned catalog pages', async () => {
    const provider = createProvider();
    await seed(provider);
    await refreshWorkspaceOutputs(provider, BOTH, renderer);
    const moved: WorkspaceSettings = {
      ...BOTH,
      catalog: { ...BOTH.catalog, html: { enabled: true, path: 'site/home.html' } },
    };
    await refreshWorkspaceOutputs(provider, moved, renderer);
    const json = JSON.parse((await read(provider, 'catalog.json'))!);
    expect(json.documents.map((entry: { path: string }) => entry.path)).not.to.include(
      'index.html',
    );
    const home = (await read(provider, 'site/home.html'))!;
    expect(home).to.contain('[Alpha Story](../alpha.md)');
  });

  it('honors dry runs and forced rewrites', async () => {
    const provider = createProvider();
    await seed(provider);
    const dry = await refreshWorkspaceOutputs(provider, BOTH, renderer, { dryRun: true });
    expect(dry.outputs.map((output) => output.status)).to.deep.equal([
      'would-write',
      'would-write',
    ]);
    expect(await read(provider, 'index.html')).to.equal(null);
    await refreshWorkspaceOutputs(provider, BOTH, renderer);
    const before = renderer.calls;
    await refreshWorkspaceOutputs(provider, BOTH, renderer, { force: true });
    expect(renderer.calls).to.equal(before + 1);
  });

  it('includes Markdown bodies only when configured', async () => {
    const provider = createProvider();
    await seed(provider);
    await refreshWorkspaceOutputs(
      provider,
      { version: 1, catalog: { json: { enabled: true, content: 'markdown' } } },
      renderer,
    );
    const json = JSON.parse((await read(provider, 'catalog.json'))!);
    expect(json.documents[2].markdown).to.equal('# Beta\n\nBeta *body*.\n');
  });

  it('writes nothing when over budget', async () => {
    const provider = createProvider();
    await seed(provider);
    let error: unknown;
    try {
      await refreshWorkspaceOutputs(provider, BOTH, renderer, { limits: { maxDocuments: 2 } });
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(WorkspaceOutputsLimitError);
    expect(await read(provider, 'catalog.json')).to.equal(null);
  });

  it('stops when cancelled', async () => {
    const provider = createProvider();
    await seed(provider);
    const controller = new AbortController();
    controller.abort();
    let error: unknown;
    try {
      await refreshWorkspaceOutputs(provider, BOTH, renderer, { signal: controller.signal });
    } catch (caught) {
      error = caught;
    }
    expect(error).to.be.instanceOf(FsError);
    expect((error as FsError).code).to.equal('aborted');
  });

  it('builds the page from AST text nodes so titles cannot inject links or markup', async () => {
    const provider = createProvider();
    const hostile = '<script>x</script> [link](javascript:alert(1))';
    await write(provider, 'evil.md', `---\ntitle: "${hostile}"\n---\n`);
    let captured: MarkdownDocument | null = null;
    await refreshWorkspaceOutputs(provider, BOTH, {
      renderCatalogHtml(document) {
        captured = document;
        return '<!DOCTYPE html>\n<p></p>';
      },
    });
    const links: Array<{ url: string; text: string }> = [];
    const visit = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const record = node as { type?: string; url?: string; children?: unknown[]; value?: string };
      if (record.type === 'link') {
        links.push({
          url: record.url ?? '',
          text: (record.children ?? [])
            .map((child) => (child as { value?: string }).value)
            .join(''),
        });
      }
      (record.children ?? []).forEach(visit);
    };
    visit(captured);
    expect(links).to.deep.equal([{ url: 'evil.md', text: hostile }]);
  });
});

describe('workspace output helpers', () => {
  it('ignores its own outputs and hidden bookkeeping when deciding to refresh', () => {
    expect(isCatalogRelevantPath('notes/a.md', BOTH)).to.equal(true);
    expect(isCatalogRelevantPath('/Battle_files/battle.md', BOTH)).to.equal(true);
    expect(isCatalogRelevantPath('index.html', BOTH)).to.equal(false);
    expect(isCatalogRelevantPath('Catalog.JSON', BOTH)).to.equal(false);
    expect(isCatalogRelevantPath('a_files/.versions/a.md', BOTH)).to.equal(false);
    expect(isCatalogRelevantPath('_squisq/squisq-player.js', BOTH)).to.equal(false);
    expect(isCatalogRelevantPath('a.md', { version: 1 })).to.equal(false);
    expect(isWorkspaceSettingsPath('/.docblocks/workspace.json')).to.equal(true);
    expect(isWorkspaceSettingsPath('docblocks/workspace.json')).to.equal(false);
  });

  it('computes encoded relative links from the catalog directory', () => {
    expect(relativeCatalogLink('', 'a b/c#d.md')).to.equal('a%20b/c%23d.md');
    expect(relativeCatalogLink('site', 'site/x.md')).to.equal('x.md');
    expect(relativeCatalogLink('site/deep', 'docs/x.md')).to.equal('../../docs/x.md');
  });

  it('recognizes generated JSON by its leading generator key only', () => {
    expect(isGeneratedCatalogJson('{\n  "generator": "docblocks-workspace-catalog",')).to.equal(
      true,
    );
    expect(
      isGeneratedCatalogJson('{"title":"x","generator":"docblocks-workspace-catalog"}'),
    ).to.equal(false);
  });
});
