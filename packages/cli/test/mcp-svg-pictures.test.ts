import { expect } from 'chai';
import { parseInspectionResult, type McpDiagnostic } from '@bendyline/docblocks/mcp';
import { parseMarkdown, parseSvgIsland } from '@bendyline/squisq/markdown';
import { svgPictureDiagnostics } from '../src/mcp/intelligence.js';
import { PICTURE_SELECTION_GUIDANCE, SVG_ISLAND_EXAMPLE } from '../src/mcp/picture-guidance.js';
import { callTool, startMcpHarness, type McpHarness } from './mcp-helpers.js';

const TITLED = '<svg viewBox="0 0 10 10"><title>Square</title><rect width="5" height="5"/></svg>';

function fence(body: string, lang = 'svg', indent = ''): string {
  return [`\`\`\`${lang}`, ...body.split('\n'), '```'].map((line) => indent + line).join('\n');
}

async function svgDiagnostics(markdown: string): Promise<McpDiagnostic[]> {
  return svgPictureDiagnostics(parseMarkdown(markdown), 'inspect', 'md');
}

function byCode(diagnostics: readonly McpDiagnostic[], code: string): McpDiagnostic[] {
  return diagnostics.filter((diagnostic) => diagnostic.code === code);
}

describe('MCP SVG picture diagnostics', function () {
  this.timeout(30_000);

  it('reports nothing for a titled, fully retained fence or SVG shown as code', async () => {
    const diagnostics = await svgDiagnostics(
      ['# Clean', '', fence(TITLED), '', fence(TITLED, 'xml'), '', fence(TITLED, '')].join('\n'),
    );
    expect(diagnostics).to.deep.equal([]);
  });

  it('reports a fence that cannot be drawn as an error naming the reason', async () => {
    const diagnostics = await svgDiagnostics(
      ['# Broken', '', fence('<p>not a picture</p>'), '', fence('')].join('\n'),
    );
    const failures = byCode(diagnostics, 'svg-fence-not-rendered');
    expect(failures).to.have.length(2);
    expect(failures[0]).to.deep.include({
      severity: 'error',
      stage: 'inspect',
      format: 'md',
      count: 1,
      location: { kind: 'source', line: 3, column: 1 },
    });
    expect(failures[0]?.message).to.include('line 3').and.include('(not-svg)');
    expect(failures[0]?.message).to.include('An SVG fence must hold one <svg> element');
    expect(failures[0]?.message).to.include('shows as code');
    expect(failures[0]?.remediation).to.include('```xml');
    expect(failures[1]?.message).to.include('(empty)');
    // A fence that cannot be drawn is not also reported as untitled.
    expect(byCode(diagnostics, 'svg-missing-title')).to.deep.equal([]);
  });

  it('names the limits when a fence is nested too deeply', async () => {
    const deep = `<svg viewBox="0 0 1 1"><title>Deep</title>${'<g>'.repeat(205)}${'</g>'.repeat(205)}</svg>`;
    const [failure] = byCode(
      await svgDiagnostics(`# Deep\n\n${fence(deep)}`),
      'svg-fence-not-rendered',
    );
    expect(failure?.message).to.include('(too-deep)');
    expect(failure?.remediation).to.include('200 levels');
  });

  it('warns with what the sanitizer removed from a fence that still draws', async () => {
    const diagnostics = await svgDiagnostics(
      [
        '# Removed',
        '',
        fence(
          '<svg viewBox="0 0 10 10" onclick="a()"><title>Removed</title><script>alert(1)</script><rect onclick="b()" width="5" height="5"/></svg>',
        ),
      ].join('\n'),
    );
    const [removed] = byCode(diagnostics, 'svg-content-removed');
    expect(removed).to.deep.include({
      severity: 'warning',
      count: 3,
      location: { kind: 'source', line: 3, column: 1 },
    });
    expect(removed?.message).to.include('<script> ×1').and.include('onclick ×2');
    expect(removed?.message).to.include('draws');
    expect(byCode(diagnostics, 'svg-fence-not-rendered')).to.deep.equal([]);
    expect(byCode(diagnostics, 'svg-missing-title')).to.deep.equal([]);
  });

  it('aggregates fences without an accessible name like missing alt text', async () => {
    const untitled = '<svg viewBox="0 0 10 10"><rect width="5" height="5"/></svg>';
    const labelled =
      '<svg viewBox="0 0 10 10" aria-label="Square"><rect width="5" height="5"/></svg>';
    const single = byCode(
      await svgDiagnostics(`# One\n\n${fence(untitled)}\n\n${fence(labelled)}`),
      'svg-missing-title',
    );
    expect(single).to.have.length(1);
    expect(single[0]).to.deep.include({
      severity: 'warning',
      count: 1,
      location: { kind: 'source', line: 3, column: 1 },
    });
    expect(single[0]?.message).to.include('(line 3)');
    expect(single[0]?.remediation).to.include('<title>');

    const several = byCode(
      await svgDiagnostics(`# Two\n\n${fence(untitled)}\n\n${fence(untitled)}`),
      'svg-missing-title',
    );
    expect(several).to.have.length(1);
    expect(several[0]).to.deep.include({ count: 2, location: null });
    expect(several[0]?.message).to.include('2 ```svg fences').and.include('(lines 3, 7)');
  });

  it('finds fences nested in lists, quotes, and SVG-cased fence languages', async () => {
    const markdown = [
      '# Nested',
      '',
      '- Item',
      '',
      fence('<svg viewBox="0 0 1 1"></svg>', 'svg', '  '),
      '',
      '> Quote',
      '>',
      fence('not svg', 'SVG', '> '),
    ].join('\n');
    const diagnostics = await svgDiagnostics(markdown);
    expect(byCode(diagnostics, 'svg-missing-title')[0]?.location).to.deep.equal({
      kind: 'source',
      line: 5,
      column: 3,
    });
    expect(byCode(diagnostics, 'svg-fence-not-rendered')[0]?.location).to.deep.equal({
      kind: 'source',
      line: 11,
      column: 3,
    });
  });

  it('warns that raw <svg> HTML blocks and inline tags are dropped', async () => {
    const diagnostics = await svgDiagnostics(
      [
        '# Raw',
        '',
        '<svg viewBox="0 0 10 10">',
        '  <rect width="5" height="5"/>',
        '</svg>',
        '',
        'Inline <svg viewBox="0 0 1 1"></svg> art.',
        '',
        '<!-- <svg></svg> -->',
        '',
        '<div title="<svg>">Not a picture tag</div>',
      ].join('\n'),
    );
    const raw = byCode(diagnostics, 'raw-svg-html-dropped');
    expect(raw.map(({ location }) => location)).to.deep.equal([
      { kind: 'source', line: 3, column: 1 },
      { kind: 'source', line: 7, column: 8 },
    ]);
    expect(raw[0]).to.deep.include({ severity: 'warning', count: 1 });
    expect(raw[0]?.message).to.include('line 3').and.include('Markdown sanitizer');
    expect(raw[0]?.remediation).to.include('```svg fence').and.include('```xml fence');
  });

  it('bounds the number of sanitized fences with an explicit aggregate', async () => {
    const markdown = ['# Many', ...Array.from({ length: 1_002 }, () => fence(TITLED))].join('\n\n');
    const diagnostics = await svgDiagnostics(markdown);
    expect(diagnostics).to.have.length(1);
    expect(diagnostics[0]).to.deep.include({
      code: 'svg-analysis-truncated',
      severity: 'info',
      count: 2,
    });
  });

  it('honors cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    let caught: unknown;
    try {
      await svgPictureDiagnostics(parseMarkdown(fence(TITLED)), 'inspect', 'md', controller.signal);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(Error);
  });
});

describe('MCP SVG picture inspection and guidance', function () {
  this.timeout(30_000);
  let harness: McpHarness;

  beforeEach(async () => {
    harness = await startMcpHarness();
  });

  afterEach(async () => harness.dispose());

  it('publishes SVG findings through inspect_document with absolute source lines', async () => {
    const result = await callTool(harness.client, 'inspect_document', {
      source: {
        kind: 'markdown',
        name: 'pictures.md',
        markdown: [
          '---',
          'title: Pictures',
          '---',
          '',
          '# Pictures',
          '',
          fence('<svg viewBox="0 0 1 1"><script>x()</script></svg>'),
          '',
          fence('just text'),
          '',
          '<svg viewBox="0 0 1 1">',
          '</svg>',
        ].join('\n'),
      },
    });
    expect(result.isError, result.text).to.equal(false);
    const inspection = parseInspectionResult(result.structuredContent);
    expect(inspection).to.not.equal(null);
    const codes = inspection!.diagnostics.map(({ code, severity, location }) => ({
      code,
      severity,
      line: location?.kind === 'source' ? location.line : null,
    }));
    expect(codes).to.deep.include.members([
      { code: 'svg-content-removed', severity: 'warning', line: 7 },
      { code: 'svg-missing-title', severity: 'warning', line: 7 },
      { code: 'svg-fence-not-rendered', severity: 'error', line: 11 },
      { code: 'raw-svg-html-dropped', severity: 'warning', line: 15 },
    ]);
  });

  it('publishes a versioned pictures section in the authoring guide', async () => {
    const response = await harness.client.readResource({ uri: 'docblocks://authoring-guide' });
    const content = response.contents[0];
    if (!content || !('text' in content)) throw new Error('Expected the authoring guide as text');
    const guide = JSON.parse(content.text) as {
      version: number;
      workflow: string[];
      templates: Array<{ id: string }>;
      pictures: {
        choose: string[];
        chartTemplates: string[];
        svgRules: string[];
        svgExample: string;
        never: string;
        exports: string[];
        check: string;
      };
    };
    expect(guide.version).to.equal(11);
    expect(guide.workflow.some((step) => step.includes('pictures.choose'))).to.equal(true);
    const { pictures } = guide;
    const choose = pictures.choose.join('\n');
    for (const format of ['```mermaid', '```timeline', '```tree', '```svg', '{[barChart]}']) {
      expect(choose, format).to.include(format);
    }
    expect(choose).to.include('assets/name.svg').and.include('create_document_bundle');
    const templateIds = new Set(guide.templates.map(({ id }) => id));
    expect(pictures.chartTemplates).to.include('barChart').and.not.include('dataTable');
    expect(pictures.chartTemplates.every((id) => templateIds.has(id))).to.equal(true);
    const rules = pictures.svgRules.join('\n');
    for (const rule of [
      'viewBox',
      '<title>',
      'currentColor',
      'fill="none"',
      'fill-opacity',
      'foreignObject',
      '@font-face',
      'font-family="sans-serif"',
      '512 KiB',
    ]) {
      expect(rules, rule).to.include(rule);
    }
    expect(pictures.never).to.include('raw <svg>').and.include('silently drops');
    expect(pictures.never).to.include('```xml');
    expect(pictures.exports.join('\n')).to.include('Mermaid exports as source text');
    for (const code of [
      'svg-fence-not-rendered',
      'svg-content-removed',
      'svg-missing-title',
      'raw-svg-html-dropped',
      'preview_document',
    ]) {
      expect(pictures.check, code).to.include(code);
    }
    expect(pictures.svgExample).to.equal(SVG_ISLAND_EXAMPLE);
  });

  it('ships a worked SVG example that draws cleanly with an accessible name', async () => {
    const body = SVG_ISLAND_EXAMPLE.split('\n').slice(1, -1).join('\n');
    const parsed = parseSvgIsland(body);
    expect(parsed.ok).to.equal(true);
    if (!parsed.ok) return;
    expect(parsed.diagnostics).to.deep.equal([]);
    expect(parsed.island.title).to.be.a('string').and.not.equal('');
    expect(await svgDiagnostics(`# Example\n\n${SVG_ISLAND_EXAMPLE}`)).to.deep.equal([]);
  });

  it('adds compact, target-aware picture rules to the focused authoring context', async () => {
    const contexts = new Map<string, string[]>();
    for (const targetFormat of ['pptx', 'docx', 'pdf', 'html']) {
      const result = await callTool(harness.client, 'get_authoring_context', { targetFormat });
      expect(result.isError, result.text).to.equal(false);
      const workflow = result.structuredContent?.workflow as string[];
      expect(workflow).to.include(PICTURE_SELECTION_GUIDANCE);
      expect(result.text).to.include(PICTURE_SELECTION_GUIDANCE);
      contexts.set(targetFormat, workflow);
    }
    expect(contexts.get('pptx')!.join(' ')).to.include('PPTX exports Mermaid as source text');
    expect(contexts.get('docx')!.join(' ')).to.include('only ```svg becomes a picture');
    expect(contexts.get('pdf')!.join(' ')).to.include('rendered-fidelity');
    expect(contexts.get('html')!.join(' ')).not.to.include('as source text');
    expect(PICTURE_SELECTION_GUIDANCE).to.include('Never raw <svg> HTML');
    expect(PICTURE_SELECTION_GUIDANCE).to.include('inspect_document');
  });

  it('carries picture rules into server instructions and authoring prompts', async () => {
    const instructions = harness.client.getInstructions() ?? '';
    expect(instructions).to.include('never raw <svg> HTML');
    expect(instructions).to.include('```svg');

    const texts = new Map<string, string>();
    for (const [name, args] of [
      ['create-presentation', { topic: 'Orbits' }],
      ['create-document', { topic: 'Orbits' }],
      ['create-document', { topic: 'Orbits', format: 'docx' }],
    ] as const) {
      const prompt = await harness.client.getPrompt({ name, arguments: { ...args } });
      const message = prompt.messages[0];
      if (!message || message.content.type !== 'text') throw new Error('Expected a text prompt');
      texts.set(`${name}:${'format' in args ? args.format : 'default'}`, message.content.text);
    }
    for (const text of texts.values()) {
      expect(text).to.include('```svg fence').and.include('<title>');
      expect(text).to.include('raw <svg> HTML is silently dropped');
    }
    expect(texts.get('create-presentation:default')).to.include('Mermaid exports to PPTX');
    expect(texts.get('create-document:default')).to.include('rendered-fidelity');
    expect(texts.get('create-document:docx')).to.include('DOCX keeps Mermaid');
  });
});
