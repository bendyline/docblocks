import { expect } from 'chai';
import { readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { createMcpServer } from '../src/mcp/server.js';
import { callTool, startMcpHarness, type McpHarness } from './mcp-helpers.js';

const ANALYSIS_MARKDOWN = `# Root

An introduction with **strong emphasis** and a [reference](https://example.com/source).

## Metrics

Revenue grew to 4,200 units in 2019 for the small team.

### Detail

The expansion reached 87 employees across three offices.

## Result

Today the product ships to 40 countries.
`;

const TRANSFORM_MARKDOWN = `# The Numbers

Revenue grew to 4,200 units in 2019 which was a big jump for the small team.
"We never expected this kind of growth," said the founder about the year.

# The Turning Point

By 2021 the company had 87 employees across three offices and a plan.
The expansion cost 1,500,000 dollars and took fourteen months to finish.

# The Result

Today the product ships to 40 countries and the team keeps growing steadily.
`;

describe('MCP boundary and Squisq integration contracts', function () {
  this.timeout(60_000);

  let h: McpHarness;

  before(async () => {
    h = await startMcpHarness();
  });

  after(async () => {
    await h.dispose();
  });

  it('analyzes canonical text and file sources with nested-block semantics', async () => {
    const textResult = await callTool(h.client, 'analyze_markdown', {
      source: { kind: 'text', text: ANALYSIS_MARKDOWN },
    });
    expect(textResult.isError).to.equal(false);
    const textPayload = JSON.parse(textResult.text) as AnalysisPayload;
    expect(textResult.structuredContent).to.deep.equal(textPayload);
    expect(textPayload.stats).to.include({
      blockCount: 4,
      headingCount: 4,
      wordCount: 38,
      characterCount: ANALYSIS_MARKDOWN.length,
    });

    const extractedText = JSON.stringify(textPayload.extracted);
    expect(extractedText).to.not.include('**');
    expect(extractedText).to.not.include('https://example.com');

    const inputPath = join(h.tmpDir, 'analysis.md');
    await writeFile(inputPath, ANALYSIS_MARKDOWN, 'utf8');
    const fileResult = await callTool(h.client, 'analyze_markdown', {
      source: { kind: 'file', path: inputPath },
    });
    expect(fileResult.isError).to.equal(false);
    expect(JSON.parse(fileResult.text)).to.deep.equal(textPayload);
  });

  it('enforces exactly one strict markdown source at the tool boundary', async () => {
    const invalidCalls: Array<{ args: Record<string, unknown>; message: string }> = [
      { args: {}, message: 'source is required' },
      {
        args: { source: { kind: 'text', text: '# One' }, markdown: '# Two' },
        message: 'either source or markdown',
      },
      {
        args: { source: { kind: 'unknown', text: '# One' } },
        message: 'invalid arguments',
      },
      {
        args: { source: { kind: 'text', text: '# One', unexpected: true } },
        message: 'unrecognized',
      },
      {
        args: { source: { kind: 'text', text: '# One' }, unexpected: true },
        message: 'unrecognized',
      },
    ];

    for (const { args, message } of invalidCalls) {
      const result = await callTool(h.client, 'analyze_markdown', args);
      expect(result.isError, JSON.stringify(args)).to.equal(true);
      expect(result.text.toLowerCase(), JSON.stringify(args)).to.include(message);
    }

    const zeroArgumentResult = await callTool(h.client, 'list_themes', { unexpected: true });
    expect(zeroArgumentResult.isError).to.equal(true);
    expect(zeroArgumentResult.text.toLowerCase()).to.include('unrecognized');

    const wrongExtension = await callTool(h.client, 'export_markdown_to_pdf', {
      source: { kind: 'text', text: '# PDF' },
      outputPath: join(h.tmpDir, 'not-a-pdf.md'),
    });
    expect(wrongExtension.isError).to.equal(true);
    expect(wrongExtension.text).to.include('must end with .pdf');

    const invalidVideo = await callTool(h.client, 'export_markdown_to_video', {
      source: { kind: 'text', text: '# Video' },
      outputPath: join(h.tmpDir, 'video.mp4'),
      fps: 0,
    });
    expect(invalidVideo.isError).to.equal(true);
    expect(invalidVideo.text).to.include('Invalid arguments');
  });

  it('rejects oversized and unauthorized file sources through MCP', async () => {
    const limited = await startMcpHarness({ maxInputFileBytes: 4 });
    const defaultDeny = await startMcpHarness({ readRoots: [] });
    try {
      const limitedPath = join(limited.tmpDir, 'too-large.md');
      await writeFile(limitedPath, '12345', 'utf8');
      const oversized = await callTool(limited.client, 'analyze_markdown', {
        source: { kind: 'file', path: limitedPath },
      });
      expect(oversized.isError).to.equal(true);
      expect(oversized.text).to.include('file-size limit');

      const deniedPath = join(defaultDeny.tmpDir, 'denied.md');
      await writeFile(deniedPath, '# Denied', 'utf8');
      const denied = await callTool(defaultDeny.client, 'analyze_markdown', {
        source: { kind: 'file', path: deniedPath },
      });
      expect(denied.isError).to.equal(true);
      expect(denied.text).to.include('outside the configured roots');
    } finally {
      await limited.dispose();
      await defaultDeny.dispose();
    }
  });

  it('applies every discovered Squisq transform without losing source sections', async () => {
    const listed = await callTool(h.client, 'list_transform_styles', {});
    const styles = JSON.parse(listed.text) as Array<{ id: string }>;
    expect(styles).to.be.an('array').with.length.greaterThan(0);
    const outputs = new Map<string, string>();

    for (const { id } of styles) {
      const transformed = await callTool(h.client, 'restyle_markdown', {
        source: { kind: 'text', text: TRANSFORM_MARKDOWN },
        style: id,
      });
      expect(transformed.isError, id).to.equal(false);
      expect(transformed.text, id).to.include('# The Numbers');
      expect(transformed.text, id).to.include('# The Turning Point');
      expect(transformed.text, id).to.include('# The Result');
      expect(transformed.text, id).to.include('4,200 units');
      expect(transformed.text, id).to.include('87 employees');
      expect(transformed.text, id).to.include('40 countries');
      outputs.set(id, transformed.text);
    }

    expect(outputs.get('documentary')).to.include('squisq-theme: documentary');
    expect(outputs.get('documentary')).to.include('{[');

    const dataDriven = outputs.get('data-driven');
    if (!dataDriven) throw new Error('Expected the data-driven transform output');
    const [{ parseMarkdown }, { flattenRenderableBlocks, markdownToDoc, materializeBlockLayers }] =
      await Promise.all([import('@bendyline/squisq/markdown'), import('@bendyline/squisq/doc')]);
    const reparsed = markdownToDoc(parseMarkdown(dataDriven));
    const rendered = flattenRenderableBlocks(reparsed.blocks).map((block, blockIndex) =>
      materializeBlockLayers(block, {
        blockIndex,
        totalBlocks: reparsed.blocks.length,
        failureMode: 'empty',
      }),
    );
    expect(rendered.every(({ layers }) => layers.length > 0)).to.equal(true);
    const renderedJson = JSON.stringify(rendered);
    expect(renderedJson).to.include('2019');
    expect(renderedJson).to.include('Revenue grew');
  });

  it('preserves authored annotation parameters while applying a visual transform', async () => {
    const source = `# The Numbers {[sectionHeader duration=11 customLabel=keep-me]}

Revenue grew to 4,200 units in 2019 which was a big jump for the small team and changed everything.

# The Result

Today the product ships to 40 countries and the team keeps growing steadily.
`;
    const transformed = await callTool(h.client, 'restyle_markdown', {
      source: { kind: 'text', text: source },
      style: 'data-driven',
    });
    expect(transformed.isError).to.equal(false);
    expect(transformed.text).to.include('duration=11');
    expect(transformed.text).to.include('customLabel=keep-me');
    expect(transformed.text).to.include('date="in 2019"');
    expect(transformed.text).to.include('description="Revenue grew');
  });

  it('keeps authored template values and transitions ahead of generated transform defaults', async () => {
    const authoredValues = await callTool(h.client, 'restyle_markdown', {
      source: {
        kind: 'text',
        text: `# The Numbers {[sectionHeader date="Authored date" description="Authored description"]}

Revenue grew to 4,200 units in 2019 which was a big jump for the small team and changed everything.

# The Result

Today the product ships to 40 countries and the team keeps growing steadily.
`,
      },
      style: 'data-driven',
    });
    expect(authoredValues.isError).to.equal(false);
    expect(authoredValues.text).to.include('date="Authored date"');
    expect(authoredValues.text).to.include('description="Authored description"');

    const authoredTransition = await callTool(h.client, 'restyle_markdown', {
      source: {
        kind: 'text',
        text: `# The Numbers {[sectionHeader transition=wipe transitionDuration=2 transitionDirection=left customLabel=keep]}

Revenue grew to 4,200 units in 2019 which was a big jump for the small team and changed everything.

# The Result

Today the product ships to 40 countries and the team keeps growing steadily.
`,
      },
      style: 'documentary',
    });
    expect(authoredTransition.isError).to.equal(false);
    expect(authoredTransition.text).to.include('transition=wipe');
    expect(authoredTransition.text).to.include('transitionDuration=2');
    expect(authoredTransition.text).to.include('transitionDirection=left');
    expect(authoredTransition.text).to.include('customLabel=keep');
    expect(authoredTransition.text).to.not.include('transition=fade');
  });

  it('validates and persists the requested theme when restyling', async () => {
    const transformed = await callTool(h.client, 'restyle_markdown', {
      source: { kind: 'text', text: TRANSFORM_MARKDOWN },
      style: 'documentary',
      theme: 'standard',
    });
    expect(transformed.isError).to.equal(false);
    expect(transformed.text).to.include('squisq-theme: standard');

    const invalid = await callTool(h.client, 'restyle_markdown', {
      source: { kind: 'text', text: TRANSFORM_MARKDOWN },
      style: 'documentary',
      theme: 'not-a-real-theme',
    });
    expect(invalid.isError).to.equal(true);
    expect(invalid.text).to.include('Unknown theme');

    const existingTheme = await callTool(h.client, 'restyle_markdown', {
      source: {
        kind: 'text',
        text: `---
squisq-theme: cinematic
---

${TRANSFORM_MARKDOWN}`,
      },
      style: 'data-driven',
    });
    expect(existingTheme.isError).to.equal(false);
    expect(existingTheme.text).to.include('squisq-theme: cinematic');
    expect(existingTheme.text).to.not.include('squisq-theme: tech-dark');

    const [{ compileTheme }, { writeCustomThemesToFrontmatter }] = await Promise.all([
      import('@bendyline/squisq/schemas'),
      import('@bendyline/squisq/doc'),
    ]);
    const customTheme = compileTheme({
      id: 'my-brand',
      name: 'My Brand',
      seedColors: { primary: '#3182ce', secondary: '#805ad5' },
    });
    const encodedTheme = writeCustomThemesToFrontmatter([customTheme]);
    const custom = await callTool(h.client, 'restyle_markdown', {
      source: {
        kind: 'text',
        text: `---
squisq-theme: my-brand
squisq-custom-themes: ${encodedTheme}
---

${TRANSFORM_MARKDOWN}`,
      },
      style: 'data-driven',
      theme: 'my-brand',
    });
    expect(custom.isError).to.equal(false);
    expect(custom.text).to.include('squisq-theme: my-brand');
    expect(custom.text).to.include('squisq-custom-themes:');
  });

  it('stages file-backed exports without touching input-derived sibling files', async () => {
    const sourcePath = join(h.tmpDir, 'source.md');
    const collateralPath = join(h.tmpDir, 'source.html');
    const outputPath = join(h.tmpDir, 'requested.html');
    await writeFile(sourcePath, TRANSFORM_MARKDOWN, 'utf8');
    await writeFile(collateralPath, 'DO NOT REPLACE', 'utf8');
    await writeFile(outputPath, 'REPLACE THIS TARGET', 'utf8');

    const result = await callTool(h.client, 'export_markdown_to_html', {
      source: { kind: 'file', path: sourcePath },
      outputPath,
      theme: 'standard',
      transform: 'data-driven',
    });
    expect(result.isError).to.equal(false);
    expect(await readFile(collateralPath, 'utf8')).to.equal('DO NOT REPLACE');

    const html = await readFile(outputPath, 'utf8');
    expect(html.toLowerCase()).to.include('<!doctype html');
    expect(html).to.include('The Numbers');
    const payload = JSON.parse(result.text) as { fileSize: number; outputPath: string };
    expect(result.structuredContent).to.deep.equal(JSON.parse(result.text));
    expect(payload.outputPath).to.equal(join(await realpath(h.tmpDir), 'requested.html'));
    expect(payload.fileSize).to.equal((await stat(outputPath)).size);
    expect(await exportStagingEntries(h.tmpDir)).to.deep.equal([]);
  });

  it('preserves bundled media across the Squisq DBK-to-HTML pipeline', async () => {
    const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
      'base64',
    );
    const archive = new JSZip();
    archive.file('index.md', '# Bundled media\n\n![A pixel](images/pixel.png)\n');
    archive.file('images/pixel.png', image);
    const inputPath = join(h.tmpDir, 'media.dbk');
    const outputPath = join(h.tmpDir, 'media.html');
    await writeFile(inputPath, await archive.generateAsync({ type: 'nodebuffer' }));

    const result = await callTool(h.client, 'export_markdown_to_html', {
      source: { kind: 'file', path: inputPath },
      outputPath,
    });
    expect(result.isError).to.equal(false);
    const html = await readFile(outputPath, 'utf8');
    expect(html).to.include('data:image/png;base64,');
    expect(html).to.include(image.toString('base64'));
    expect(await exportStagingEntries(h.tmpDir)).to.deep.equal([]);
  });

  it('propagates malformed container failures and cleans export staging', async () => {
    const inputPath = join(h.tmpDir, 'malformed.dbk');
    const outputPath = join(h.tmpDir, 'malformed.html');
    await writeFile(inputPath, Buffer.from('PK\u0003\u0004not-a-valid-archive'));

    const result = await callTool(h.client, 'export_markdown_to_html', {
      source: { kind: 'file', path: inputPath },
      outputPath,
    });
    expect(result.isError).to.equal(true);
    expect(await pathExists(outputPath)).to.equal(false);
    expect(await exportStagingEntries(h.tmpDir)).to.deep.equal([]);
  });

  it('bounds concurrent expensive operations and validates the configured limit', async () => {
    expect(() => createMcpServer({ maxConcurrentOperations: 0 })).to.throw(
      'Invalid MCP operation concurrency limit',
    );
    expect(() => createMcpServer({ maxConcurrentOperations: 1.5 })).to.throw(
      'Invalid MCP operation concurrency limit',
    );
    expect(() => createMcpServer({ maxConcurrentOperations: 33 })).to.throw(
      'Invalid MCP operation concurrency limit',
    );

    const serial = await startMcpHarness({ maxConcurrentOperations: 1 });
    try {
      const results = await Promise.all([
        callTool(serial.client, 'analyze_markdown', {
          source: { kind: 'text', text: ANALYSIS_MARKDOWN },
        }),
        callTool(serial.client, 'analyze_markdown', {
          source: { kind: 'text', text: ANALYSIS_MARKDOWN },
        }),
      ]);
      expect(results.filter((result) => !result.isError)).to.have.length(1);
      const busy = results.find((result) => result.isError);
      expect(busy?.text).to.include('busy; retry later');
    } finally {
      await serial.dispose();
    }
  });
});

interface AnalysisPayload {
  stats: {
    blockCount: number;
    headingCount: number;
    paragraphCount: number;
    wordCount: number;
    characterCount: number;
  };
  extracted: unknown;
}

async function exportStagingEntries(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((entry) => entry.startsWith('.docblocks-mcp-export-'));
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch(() => false);
}
