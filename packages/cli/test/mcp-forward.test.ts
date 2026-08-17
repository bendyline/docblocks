import { expect } from 'chai';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { parseConversionResult, parseInspectionResult } from '@bendyline/docblocks/mcp';
import JSZip from 'jszip';
import { callTool, SAMPLE_MARKDOWN, startMcpHarness, type McpHarness } from './mcp-helpers.js';

describe('MCP canonical authoring surface', function () {
  this.timeout(60_000);

  let harness: McpHarness;

  beforeEach(async () => {
    harness = await startMcpHarness();
  });

  afterEach(async () => harness.dispose());

  it('creates DOCX, PPTX, PDF, and HTML artifacts in one normalized conversion', async () => {
    const converted = await callTool(harness.client, 'convert_document', {
      source: { kind: 'markdown', markdown: SAMPLE_MARKDOWN, name: 'bridge.md' },
      targets: [
        { format: 'docx', fidelity: 'editable-native' },
        { format: 'pptx', fidelity: 'editable-native' },
        { format: 'pdf', fidelity: 'semantic' },
        { format: 'html', fidelity: 'semantic' },
      ],
    });
    expect(converted.isError, converted.text).to.equal(false);
    const rawResults = converted.structuredContent?.results;
    expect(rawResults).to.be.an('array').with.length(4);
    if (!Array.isArray(rawResults)) throw new Error('Expected conversion results');
    const results = rawResults.map((value) => parseConversionResult(value));
    expect(results.every((value) => value !== null)).to.equal(true);
    const byFormat = new Map(results.map((result) => [result!.targetFormat, result!]));

    expect(
      (await readArtifact(harness.client, byFormat.get('docx')!.artifact.uri)).subarray(0, 4),
    ).to.deep.equal(Buffer.from('504b0304', 'hex'));
    expect(
      (await readArtifact(harness.client, byFormat.get('pptx')!.artifact.uri)).subarray(0, 4),
    ).to.deep.equal(Buffer.from('504b0304', 'hex'));
    expect(
      (await readArtifact(harness.client, byFormat.get('pdf')!.artifact.uri)).subarray(0, 5),
    ).to.deep.equal(Buffer.from('%PDF-'));
    const html = (await readArtifact(harness.client, byFormat.get('html')!.artifact.uri)).toString(
      'utf8',
    );
    expect(html.toLowerCase()).to.include('<!doctype html');
    expect(html).to.include('Golden Gate Bridge');
  });

  it('creates structurally valid HTMLZIP and EPUB artifacts through the canonical tool', async () => {
    const converted = await callTool(harness.client, 'convert_document', {
      source: { kind: 'markdown', markdown: SAMPLE_MARKDOWN, name: 'bridge.md' },
      targets: [
        { format: 'htmlzip', fidelity: 'semantic' },
        { format: 'epub', fidelity: 'semantic' },
      ],
    });
    expect(converted.isError, converted.text).to.equal(false);
    const rawResults = converted.structuredContent?.results;
    expect(rawResults).to.be.an('array').with.length(2);
    if (!Array.isArray(rawResults)) throw new Error('Expected archive conversion results');
    const results = rawResults.map((value) => parseConversionResult(value));
    expect(results.every((value) => value !== null)).to.equal(true);
    const byFormat = new Map(results.map((result) => [result!.targetFormat, result!]));

    const htmlzip = byFormat.get('htmlzip');
    expect(htmlzip?.artifact).to.include({ format: 'htmlzip', mimeType: 'application/zip' });
    expect(htmlzip?.artifact.suggestedFilename).to.equal('bridge.html.zip');
    if (!htmlzip) throw new Error('Expected an HTMLZIP conversion result');
    const htmlArchive = await JSZip.loadAsync(
      await readArtifact(harness.client, htmlzip.artifact.uri),
    );
    expect(Object.keys(htmlArchive.files)).to.include.members(['index.html', 'squisq-player.js']);
    const archivedHtml = await requireZipText(htmlArchive, 'index.html');
    expect(archivedHtml.toLowerCase()).to.include('<!doctype html');
    expect(archivedHtml).to.include('Golden Gate Bridge');
    expect(archivedHtml).to.include('squisq-player.js');
    expect((await requireZipText(htmlArchive, 'squisq-player.js')).length).to.be.greaterThan(1_000);

    const epub = byFormat.get('epub');
    expect(epub?.artifact).to.include({
      format: 'epub',
      mimeType: 'application/epub+zip',
    });
    expect(epub?.artifact.suggestedFilename).to.equal('bridge.epub');
    if (!epub) throw new Error('Expected an EPUB conversion result');
    const epubArchive = await JSZip.loadAsync(
      await readArtifact(harness.client, epub.artifact.uri),
    );
    expect(Object.keys(epubArchive.files)).to.include.members([
      'mimetype',
      'META-INF/container.xml',
      'OEBPS/styles.css',
      'OEBPS/toc.xhtml',
      'OEBPS/content.opf',
      'OEBPS/chapters/chapter-001.xhtml',
    ]);
    expect(await requireZipText(epubArchive, 'mimetype')).to.equal('application/epub+zip');
    expect(await requireZipText(epubArchive, 'META-INF/container.xml')).to.include(
      'OEBPS/content.opf',
    );
    const packageManifest = await requireZipText(epubArchive, 'OEBPS/content.opf');
    expect(packageManifest).to.include('bridge');
    expect(packageManifest).to.include('chapters/chapter-001.xhtml');
    expect(await requireZipText(epubArchive, 'OEBPS/toc.xhtml')).to.include('Golden Gate Bridge');
    expect(await requireZipText(epubArchive, 'OEBPS/chapters/chapter-001.xhtml')).to.include(
      'Golden Gate Bridge',
    );
  });

  it('inspects canonical Markdown with bounded structure and provenance', async () => {
    const result = await callTool(harness.client, 'inspect_document', {
      source: { kind: 'markdown', markdown: SAMPLE_MARKDOWN, name: null },
      maxBlocks: 10,
    });
    expect(result.isError, result.text).to.equal(false);
    const inspection = parseInspectionResult(result.structuredContent);
    expect(inspection).to.not.equal(null);
    expect(inspection?.statistics.wordCount).to.be.greaterThan(0);
    expect(inspection?.outline.length).to.be.greaterThan(0);
    expect(inspection?.blocks.every((block) => block.sourceRange !== null)).to.equal(true);
  });

  it('discovers the linked format, theme, and transform vocabulary', async () => {
    const formats = await callTool(harness.client, 'list_formats', {});
    const themes = await callTool(harness.client, 'list_themes', {});
    const transforms = await callTool(harness.client, 'list_transform_styles', {});
    expect(formats.isError, formats.text).to.equal(false);
    expect(themes.isError, themes.text).to.equal(false);
    expect(transforms.isError, transforms.text).to.equal(false);
    expect(formats.structuredContent?.formats).to.be.an('array').with.length(13);
    expect(themes.structuredContent?.themes).to.be.an('array').with.length.greaterThan(0);
    expect(transforms.structuredContent?.styles).to.be.an('array').with.length.greaterThan(0);
  });
});

async function readArtifact(client: Client, uri: string): Promise<Buffer> {
  const response = await client.readResource({ uri });
  const content = response.contents[0];
  if (!content || !('blob' in content) || typeof content.blob !== 'string') {
    if (content && 'text' in content && typeof content.text === 'string') {
      return Buffer.from(content.text, 'utf8');
    }
    throw new Error(`Expected artifact bytes for ${uri}`);
  }
  return Buffer.from(content.blob, 'base64');
}

async function requireZipText(archive: JSZip, path: string): Promise<string> {
  const entry = archive.file(path);
  if (!entry) throw new Error(`Expected ZIP entry ${path}`);
  return entry.async('string');
}
