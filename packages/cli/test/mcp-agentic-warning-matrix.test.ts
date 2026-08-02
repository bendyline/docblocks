import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  parseConversionResult,
  type ConversionResult,
  type McpDiagnostic,
} from '@bendyline/docblocks/mcp';
import { PDFDocument, rgb } from 'pdf-lib';
import { callTool, startMcpHarness, type McpHarness } from './mcp-helpers.js';

const LOSSY_MARKDOWN = `# Warning matrix

Introductory prose is intentionally not tabular.

:::notice[Important]
Container directives are not represented by every document format.
:::

::pagebreak[Break]

Inline :badge[value] directive.

| A | B |
| --- | --- |
| one | two |

| C | D |
| --- | --- |
| three | four |
`;

describe('MCP canonical linked warning matrix', function () {
  this.timeout(60_000);

  let harness: McpHarness;

  beforeEach(async () => {
    harness = await startMcpHarness();
  });

  afterEach(async () => harness.dispose());

  // Squisq 2.4.2 switched PPTX export from `markdownDocToPptx` to `docToPptx`
  // so `###`-level slides stop collapsing into their H2 parent. The redundant
  // thematic-break warning is raised by the markdown segmentation path only, so
  // no PPTX conversion emits it any more; this exercises the same front-loading
  // contract through a warning that the current pipeline still raises.
  it('front-loads multi-occurrence conversion warnings ahead of the JSON result', async () => {
    const result = await callTool(harness.client, 'convert_document', {
      source: {
        kind: 'markdown',
        markdown: LOSSY_MARKDOWN,
        name: 'front-loaded-warnings.md',
      },
      targets: [{ format: 'docx', fidelity: 'editable-native' }],
    });

    expect(result.isError, result.text).to.equal(false);
    const converted = requireTarget(requireConversions(result.structuredContent?.results), 'docx');
    const warning = requireWarning(converted.diagnostics, 'docx', 'unsupported-markdown-node');
    expect(warning.count).to.equal(3);
    expect(result.text).to.match(/^Conversion warnings:/u);
    expect(result.text).to.include('3 occurrence(s) across 1 diagnostic(s).');
    expect(result.text).to.include(`- [unsupported-markdown-node] docx x3: ${warning.message}`);
    expect(result.text).to.include(
      'The complete JSON result follows in the next text content item.',
    );
  });

  it('projects unsupported directives, multiple CSV tables, and XLSX omissions exactly', async () => {
    const result = await callTool(harness.client, 'convert_document', {
      source: {
        kind: 'markdown',
        markdown: LOSSY_MARKDOWN,
        name: 'warning-matrix.md',
      },
      targets: [
        { format: 'docx', fidelity: 'editable-native' },
        { format: 'csv', fidelity: 'semantic' },
        { format: 'xlsx', fidelity: 'editable-native' },
      ],
    });

    expect(result.isError, result.text).to.equal(false);
    const results = requireConversions(result.structuredContent?.results);
    const docx = requireTarget(results, 'docx');
    const csv = requireTarget(results, 'csv');
    const xlsx = requireTarget(results, 'xlsx');

    const directiveWarning = requireWarning(docx.diagnostics, 'docx', 'unsupported-markdown-node');
    expect(directiveWarning.message).to.include('unsupported Markdown node(s)');
    expect(directiveWarning.message).to.include('containerDirective (1)');
    expect(directiveWarning.message).to.include('leafDirective (1)');
    expect(directiveWarning.message).to.include('textDirective (1)');

    const csvWarning = requireWarning(csv.diagnostics, 'csv', 'csv-table-selection');
    expect(csvWarning.message).to.equal(
      'Document has 2 tables; CSV export emitted only the first. ' +
        "Use the csv converter's tableIndex option to select another.",
    );

    const xlsxWarning = requireWarning(xlsx.diagnostics, 'xlsx', 'xlsx-content-omitted');
    expect(xlsxWarning.message).to.match(
      /^XLSX export is tables-only; [1-9][0-9]* non-table block\(s\) were omitted\.$/u,
    );
  });

  it('preserves linked PDF embedded images on Node imports', async () => {
    const pdfPath = join(harness.tmpDir, 'embedded-image.pdf');
    await writeFile(pdfPath, await pdfWithEmbeddedImage());
    const rootId = await requireReadableRootId(harness.client);
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    try {
      const result = await callTool(harness.client, 'convert_document', {
        source: {
          kind: 'file',
          rootId,
          path: 'embedded-image.pdf',
          format: 'pdf',
        },
        targets: [{ format: 'md', fidelity: 'semantic' }],
      });

      expect(result.isError, result.text).to.equal(false);
      const converted = requireTarget(requireConversions(result.structuredContent?.results), 'md');
      expect(converted.sourceAssetCount).to.equal(1);
      expect(converted.sourceAssets).to.have.length(1);
      expect(converted.sourceAssets[0]).to.include({ mimeType: 'image/png' });
      expect(converted.sourceAssets[0]?.size).to.be.greaterThan(0);
      const omissionWarning = converted.diagnostics.find(
        (diagnostic) =>
          diagnostic.code === 'pdf-image-omitted' &&
          diagnostic.severity === 'warning' &&
          diagnostic.stage === 'import',
      );
      expect(omissionWarning).to.equal(undefined);

      const resource = await harness.client.readResource({ uri: converted.artifact.uri });
      const content = resource.contents[0];
      if (!content || !('text' in content)) throw new Error('Expected Markdown artifact text');
      expect(content.text).to.include('images/image1.png');
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
      else Reflect.deleteProperty(globalThis, 'document');
    }
  });
});

describe('MCP canonical real rendered-media integration', function () {
  this.timeout(120_000);

  let harness: McpHarness;
  let previousFfmpegOverride: string | undefined;

  before(async function () {
    previousFfmpegOverride = process.env.SQUISQ_FFMPEG;
    configureWorkspaceFfmpegOverride();
    const missing = await missingRenderedMediaDependencies();
    if (missing.length === 0) return;
    console.error(`  (skipping canonical real-media tests - missing ${missing.join(' and ')})`);
    this.skip();
  });

  beforeEach(async () => {
    harness = await startMcpHarness({ operationTimeoutMs: 120_000 });
  });

  afterEach(async () => harness.dispose());

  after(() => {
    if (previousFfmpegOverride === undefined) delete process.env.SQUISQ_FFMPEG;
    else process.env.SQUISQ_FFMPEG = previousFfmpegOverride;
  });

  it('projects the linked audio-omission warning from a real GIF conversion', async () => {
    const result = await callTool(harness.client, 'convert_document', {
      source: {
        kind: 'markdown',
        name: 'audio-warning.md',
        markdown:
          '{[audio src=audio/voice.mp3 anchor=document]}\n\n' +
          '# Audio warning {duration=1}\n\nA short rendered fixture.\n',
      },
      targets: [
        {
          format: 'gif',
          fidelity: 'rendered-fidelity',
          fps: 2,
          width: 160,
          height: 90,
          animationsEnabled: false,
          maxColors: 16,
        },
      ],
    });

    expect(result.isError, result.text).to.equal(false);
    const converted = requireTarget(requireConversions(result.structuredContent?.results), 'gif');
    const warning = requireWarning(converted.diagnostics, 'gif', 'gif-audio-omitted');
    expect(warning.message).to.equal(
      'Animated GIF does not support audio; audio tracks were omitted.',
    );
  });

  it('publishes a real bounded MP4 artifact through the linked renderer', async () => {
    const result = await callTool(harness.client, 'convert_document', {
      source: {
        kind: 'markdown',
        name: 'real-video.md',
        markdown: '# Real video {duration=1}\n\nA short rendered fixture.\n',
      },
      targets: [
        {
          format: 'mp4',
          fidelity: 'rendered-fidelity',
          fps: 2,
          width: 160,
          height: 90,
          quality: 'draft',
          animationsEnabled: false,
        },
      ],
    });

    expect(result.isError, result.text).to.equal(false);
    const converted = requireTarget(requireConversions(result.structuredContent?.results), 'mp4');
    expect(converted).to.include({ fidelity: 'rendered-fidelity', targetFormat: 'mp4' });
    expect(converted.artifact).to.include({ format: 'mp4', mimeType: 'video/mp4' });
    const resource = await harness.client.readResource({ uri: converted.artifact.uri });
    const content = resource.contents[0];
    if (!content || !('blob' in content)) throw new Error('Expected binary MP4 resource');
    const bytes = Buffer.from(content.blob, 'base64');
    expect(bytes.subarray(4, 8).toString('ascii')).to.equal('ftyp');
  });
});

function requireConversions(value: unknown): ConversionResult[] {
  if (!Array.isArray(value)) throw new Error('Expected canonical conversion results');
  return value.map((candidate) => {
    const parsed = parseConversionResult(candidate);
    if (!parsed) throw new Error('Expected an exact canonical conversion result');
    return parsed;
  });
}

function requireTarget(results: readonly ConversionResult[], format: string): ConversionResult {
  const result = results.find((candidate) => candidate.targetFormat === format);
  if (!result) throw new Error(`Expected ${format} conversion result`);
  return result;
}

function requireWarning(
  diagnostics: readonly McpDiagnostic[],
  format: string,
  code: string,
): McpDiagnostic {
  const warning = diagnostics.find(
    (candidate) =>
      candidate.code === code &&
      candidate.severity === 'warning' &&
      candidate.stage === 'convert' &&
      candidate.format === format,
  );
  if (!warning) throw new Error(`Expected a ${format} fidelity warning`);
  return warning;
}

async function requireReadableRootId(client: Client): Promise<string> {
  const roots = await callTool(client, 'list_roots', {});
  const values = roots.structuredContent?.roots;
  if (!Array.isArray(values)) throw new Error('Expected MCP root descriptors');
  const root = values.find(
    (candidate): candidate is { id: string; read: true } =>
      typeof candidate === 'object' &&
      candidate !== null &&
      typeof (candidate as { id?: unknown }).id === 'string' &&
      (candidate as { read?: unknown }).read === true,
  );
  if (!root) throw new Error('Expected a readable MCP root');
  return root.id;
}

async function pdfWithEmbeddedImage(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([200, 120]);
  page.drawText('Embedded image fixture', { x: 20, y: 90, size: 12 });
  const png = await document.embedPng(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  page.drawImage(png, { x: 20, y: 20, width: 40, height: 40 });
  page.drawRectangle({ x: 70, y: 20, width: 40, height: 40, color: rgb(0.2, 0.4, 0.8) });
  return document.save();
}

async function missingRenderedMediaDependencies(): Promise<string[]> {
  const missing: string[] = [];
  if (!hasFfmpeg()) missing.push('ffmpeg');
  try {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ headless: true, timeout: 10_000 });
    await browser.close();
  } catch {
    missing.push('Playwright Chromium');
  }
  return missing;
}

function hasFfmpeg(): boolean {
  if (process.env.SQUISQ_FFMPEG) {
    const probe = spawnSync(process.env.SQUISQ_FFMPEG, ['-version'], {
      stdio: 'ignore',
      timeout: 5_000,
    });
    return probe.status === 0;
  }
  const pathProbe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], {
    stdio: 'ignore',
    timeout: 5_000,
  });
  if (pathProbe.status === 0) return true;
  try {
    const linkedRequire = createRequire(
      new URL('../../../../squisq/packages/cli/package.json', import.meta.url),
    );
    const bundled: unknown = linkedRequire('ffmpeg-static');
    if (typeof bundled !== 'string') return false;
    const probe = spawnSync(bundled, ['-version'], { stdio: 'ignore', timeout: 5_000 });
    return probe.status === 0;
  } catch {
    return false;
  }
}

/**
 * Linked Squisq resolves optional packages from its real checkout, not from
 * this workspace. Point it at the root's dev-only ffmpeg-static binary so the
 * canonical integration test exercises the renderer actually installed here.
 * Desktop packaging excludes this dependency from its production closure.
 */
function configureWorkspaceFfmpegOverride(): void {
  if (process.env.SQUISQ_FFMPEG) return;
  const pathProbe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], {
    stdio: 'ignore',
    timeout: 5_000,
  });
  if (pathProbe.status === 0) return;

  try {
    const workspaceRequire = createRequire(import.meta.url);
    const bundled: unknown = workspaceRequire('ffmpeg-static');
    if (typeof bundled !== 'string') return;
    const probe = spawnSync(bundled, ['-version'], { stdio: 'ignore', timeout: 5_000 });
    if (probe.status === 0) process.env.SQUISQ_FFMPEG = bundled;
  } catch {
    // missingRenderedMediaDependencies reports the actionable skip reason.
  }
}
