/**
 * Reverse-direction MCP conversion coverage (Office/PDF -> Markdown).
 *
 * Round trips use immutable MCP artifacts in both directions. Independent
 * OOXML and archive-safety fixtures keep correlated exporter/importer defects
 * from making the reverse suite pass accidentally.
 */

import { expect } from 'chai';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  parseConversionResult,
  type ConversionResult,
  type DocumentSource,
} from '@bendyline/docblocks/mcp';
import JSZip from 'jszip';
import { startMcpHarness, callTool, SAMPLE_MARKDOWN, type McpHarness } from './mcp-helpers.js';

const TINY_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6]);
const TINY_PNG_SHA256 = createHash('sha256').update(TINY_PNG).digest('hex');
const ARCHIVE_LIMITS = {
  maxEntries: 2_048,
  maxEntryUncompressedBytes: 100 * 1024 * 1024,
  maxUncompressedBytes: 100 * 1024 * 1024,
} as const;

describe('MCP reverse-direction conversions', function () {
  this.timeout(60_000);

  let h: McpHarness;
  let readRootId: string;
  let hadDomParser = false;
  let originalDomParser: typeof DOMParser | undefined;

  before(async () => {
    // Root Mocha setup installs happy-dom for React tests. The MCP CLI itself
    // runs in Node, where linked Squisq selects its xmldom OOXML parser.
    // Exercise that production path and restore the shared test global below.
    hadDomParser = Object.prototype.hasOwnProperty.call(globalThis, 'DOMParser');
    originalDomParser = globalThis.DOMParser;
    Object.defineProperty(globalThis, 'DOMParser', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    h = await startMcpHarness();
    readRootId = await requireReadableRootId(h.client);
  });

  after(async () => {
    try {
      await h.dispose();
    } finally {
      if (hadDomParser) {
        Object.defineProperty(globalThis, 'DOMParser', {
          configurable: true,
          writable: true,
          value: originalDomParser,
        });
      } else {
        Reflect.deleteProperty(globalThis, 'DOMParser');
      }
    }
  });

  describe('DOCX -> Markdown', () => {
    it('round-trips through DOCX and Markdown artifacts while preserving key content', async () => {
      const docx = await convertOne(
        h.client,
        markdownSource(SAMPLE_MARKDOWN, 'round-trip.md'),
        'docx',
        'editable-native',
      );
      expect(docx).to.include({ sourceFormat: 'md', targetFormat: 'docx' });

      const markdown = await convertOne(
        h.client,
        { kind: 'artifact', uri: docx.artifact.uri },
        'md',
        'semantic',
      );
      expect(markdown).to.include({ sourceFormat: 'docx', targetFormat: 'md' });
      const text = await readTextArtifact(h.client, markdown);
      expect(text.trim().length).to.be.greaterThan(0);
      expect(text.toLowerCase()).to.include('golden gate bridge');
      expect(text).to.include('1937');
    });

    it('imports an independent DOCX fixture with heading and inline emphasis fidelity', async () => {
      await writeFile(join(h.tmpDir, 'independent.docx'), await independentDocxFixture());

      const markdown = await convertOne(
        h.client,
        fileSource(readRootId, 'independent.docx', 'docx'),
        'md',
        'semantic',
      );
      expect(markdown).to.include({ sourceFormat: 'docx', targetFormat: 'md' });
      const text = await readTextArtifact(h.client, markdown);
      expect(text).to.include('# Independent heading');
      expect(text).to.include('**Bold fact**');
      expect(text).to.include('*italic detail*');
    });

    it('retains embedded DOCX images in the manifest and companion DBK artifact', async () => {
      const { markdownDocToDocx } = await import('@bendyline/squisq-formats/docx');
      const docx = await markdownDocToDocx(
        {
          type: 'document',
          children: [
            { type: 'heading', depth: 1, children: [{ type: 'text', value: 'Assets' }] },
            { type: 'paragraph', children: [{ type: 'image', url: 'hero.png', alt: 'Hero' }] },
          ],
        },
        {
          images: new Map([['hero.png', { data: TINY_PNG.buffer, contentType: 'image/png' }]]),
        },
      );
      await writeFile(join(h.tmpDir, 'embedded-image.docx'), Buffer.from(docx));

      const [markdown, bundle] = await convertMany(
        h.client,
        fileSource(readRootId, 'embedded-image.docx', 'docx'),
        [
          { format: 'md', fidelity: 'semantic' },
          { format: 'dbk', fidelity: 'semantic' },
        ],
      );
      if (!markdown || !bundle) throw new Error('Expected Markdown and DBK results');
      expectExactPngManifest(markdown);
      expectExactPngManifest(bundle);
      const text = await readTextArtifact(h.client, markdown);
      await expectCanonicalImageReference(text);
      await expectExactBundledImage(h.client, bundle);
    });

    it('rejects an OOXML compression bomb through the linked bounded importer', async () => {
      const archive = new JSZip();
      archive.file('[Content_Types].xml', CONTENT_TYPES_XML);
      archive.file('word/document.xml', 'A'.repeat(2 * 1024 * 1024));
      await writeFile(
        join(h.tmpDir, 'compression-bomb.docx'),
        await archive.generateAsync({
          type: 'nodebuffer',
          compression: 'DEFLATE',
          compressionOptions: { level: 9 },
        }),
      );

      const result = await callTool(h.client, 'convert_document', {
        source: fileSource(readRootId, 'compression-bomb.docx', 'docx'),
        targets: [{ format: 'md', fidelity: 'semantic' }],
      });
      expect(result.isError).to.equal(true);
      expect(result.text.toLowerCase()).to.include('compression-ratio');
    });
  });

  describe('PPTX -> Markdown', () => {
    it('round-trips through PPTX and Markdown artifacts with slide headings', async () => {
      const pptx = await convertOne(
        h.client,
        markdownSource(SAMPLE_MARKDOWN, 'round-trip.md'),
        'pptx',
        'editable-native',
      );
      expect(pptx).to.include({ sourceFormat: 'md', targetFormat: 'pptx' });

      const markdown = await convertOne(
        h.client,
        { kind: 'artifact', uri: pptx.artifact.uri },
        'md',
        'semantic',
      );
      expect(markdown).to.include({ sourceFormat: 'pptx', targetFormat: 'md' });
      const text = await readTextArtifact(h.client, markdown);
      expect(text.trim().length).to.be.greaterThan(0);
      expect(text).to.match(/^## /m);
      expect(text.toLowerCase()).to.match(/golden gate|introduction|key facts|legacy/);
    });

    it('imports an independently assembled PPTX package', async () => {
      await writeFile(join(h.tmpDir, 'independent.pptx'), await independentPptxFixture());

      const markdown = await convertOne(
        h.client,
        fileSource(readRootId, 'independent.pptx', 'pptx'),
        'md',
        'semantic',
      );
      const text = await readTextArtifact(h.client, markdown);
      expect(text).to.include('## Independent slide');
      expect(text).to.include('Independent bullet evidence');
    });

    it('retains embedded PPTX images in the manifest and companion DBK artifact', async () => {
      const { markdownDocToPptx } = await import('@bendyline/squisq-formats/pptx');
      const pptx = await markdownDocToPptx(
        {
          type: 'document',
          children: [
            { type: 'heading', depth: 1, children: [{ type: 'text', value: 'Assets' }] },
            { type: 'paragraph', children: [{ type: 'image', url: 'hero.png', alt: 'Hero' }] },
          ],
        },
        { images: new Map([['hero.png', TINY_PNG.buffer]]) },
      );
      await writeFile(join(h.tmpDir, 'embedded-image.pptx'), Buffer.from(pptx));

      const [markdown, bundle] = await convertMany(
        h.client,
        fileSource(readRootId, 'embedded-image.pptx', 'pptx'),
        [
          { format: 'md', fidelity: 'semantic' },
          { format: 'dbk', fidelity: 'semantic' },
        ],
      );
      if (!markdown || !bundle) throw new Error('Expected Markdown and DBK results');
      expectExactPngManifest(markdown);
      expectExactPngManifest(bundle);
      const text = await readTextArtifact(h.client, markdown);
      await expectCanonicalImageReference(text);
      await expectExactBundledImage(h.client, bundle);
    });
  });

  describe('PDF -> Markdown', () => {
    it('heuristically recovers Markdown structure and text through PDF artifacts', async () => {
      const pdf = await convertOne(
        h.client,
        markdownSource(SAMPLE_MARKDOWN, 'round-trip.md'),
        'pdf',
        'semantic',
      );
      expect(pdf).to.include({ sourceFormat: 'md', targetFormat: 'pdf' });

      const markdown = await convertOne(
        h.client,
        { kind: 'artifact', uri: pdf.artifact.uri },
        'md',
        'semantic',
      );
      expect(markdown).to.include({ sourceFormat: 'pdf', targetFormat: 'md' });
      const text = await readTextArtifact(h.client, markdown);
      expect(text.trim().length).to.be.greaterThan(0);
      expect(text).to.match(/^# /m);
      expect(text).to.match(/^## /m);
      expect(text.toLowerCase()).to.match(/golden gate|bridge|1937/);
    });

    it('imports an independently assembled PDF byte fixture', async () => {
      await writeFile(join(h.tmpDir, 'independent.pdf'), independentPdfFixture());

      const markdown = await convertOne(
        h.client,
        fileSource(readRootId, 'independent.pdf', 'pdf'),
        'md',
        'semantic',
      );
      const text = await readTextArtifact(h.client, markdown);
      expect(text).to.include('Independent PDF heading');
      expect(text).to.include('Independent PDF body evidence');
    });
  });
});

type TargetFormat = 'docx' | 'pptx' | 'pdf' | 'md' | 'dbk';
type TargetFidelity = 'editable-native' | 'semantic';
interface TargetRequest {
  readonly format: TargetFormat;
  readonly fidelity: TargetFidelity;
}

async function convertOne(
  client: Client,
  source: DocumentSource,
  format: TargetFormat,
  fidelity: TargetFidelity,
): Promise<ConversionResult> {
  const results = await convertMany(client, source, [{ format, fidelity }]);
  const result = results[0];
  if (!result) throw new Error(`Expected one ${format} conversion result`);
  return result;
}

async function convertMany(
  client: Client,
  source: DocumentSource,
  targets: readonly TargetRequest[],
): Promise<ConversionResult[]> {
  const converted = await callTool(client, 'convert_document', {
    source,
    targets,
  });
  expect(converted.isError, converted.text).to.equal(false);
  const results = converted.structuredContent?.results;
  expect(results).to.be.an('array').with.length(targets.length);
  if (!Array.isArray(results)) throw new Error('Expected canonical conversion results');
  return results.map((entry, index) => {
    const result = parseConversionResult(entry);
    const target = targets[index];
    if (!result || !target) throw new Error('Expected a canonical conversion result');
    expect(result).to.include({ targetFormat: target.format, fidelity: target.fidelity });
    return result;
  });
}

async function readTextArtifact(client: Client, result: ConversionResult): Promise<string> {
  expect(result.artifact.mimeType).to.equal('text/markdown');
  const resource = await client.readResource({ uri: result.artifact.uri });
  expect(resource.contents).to.have.length(1);
  const content = resource.contents[0];
  if (!content || !('text' in content)) {
    throw new Error(`Expected text artifact resource: ${result.artifact.uri}`);
  }
  return content.text;
}

async function requireReadableRootId(client: Client): Promise<string> {
  const roots = await callTool(client, 'list_roots', {});
  expect(roots.isError, roots.text).to.equal(false);
  const entries = roots.structuredContent?.roots;
  expect(entries).to.be.an('array');
  if (!Array.isArray(entries)) throw new Error('Expected MCP root descriptors');
  const readable = entries.find(
    (entry): entry is { id: string; read: true } =>
      isRecord(entry) && typeof entry.id === 'string' && entry.read === true,
  );
  if (!readable) throw new Error('Expected a readable opaque MCP root');
  return readable.id;
}

function markdownSource(markdown: string, name: string): DocumentSource {
  return { kind: 'markdown', markdown, name };
}

function fileSource(rootId: string, path: string, format: 'docx' | 'pptx' | 'pdf'): DocumentSource {
  return { kind: 'file', rootId, path, format };
}

function expectExactPngManifest(result: ConversionResult): void {
  expect(result.sourceAssets).to.have.length(1);
  expect(result.sourceAssets[0]).to.include({
    mimeType: 'image/png',
    size: TINY_PNG.byteLength,
    sha256: TINY_PNG_SHA256,
  });
}

async function expectCanonicalImageReference(markdown: string): Promise<void> {
  const { findNodesByType, parseMarkdown } = await import('@bendyline/squisq/markdown');
  const importedImages = findNodesByType(parseMarkdown(markdown), 'image');
  expect(importedImages).to.have.length(1);
  expect((importedImages[0] as { url?: string }).url).to.equal('images/image1.png');
}

async function expectExactBundledImage(client: Client, result: ConversionResult): Promise<void> {
  expect(result).to.include({ targetFormat: 'dbk', fidelity: 'semantic' });
  const resource = await client.readResource({ uri: result.artifact.uri });
  expect(resource.contents).to.have.length(1);
  const content = resource.contents[0];
  if (!content || !('blob' in content)) {
    throw new Error(`Expected binary DBK artifact resource: ${result.artifact.uri}`);
  }
  const bytes = Buffer.from(content.blob, 'base64');
  const { zipToContainer } = await import('@bendyline/squisq-formats/container');
  const archiveBytes = new Uint8Array(bytes.byteLength);
  archiveBytes.set(bytes);
  const container = await zipToContainer(archiveBytes.buffer, ARCHIVE_LIMITS);
  const imageEntries = (await container.listFiles()).filter((entry) =>
    entry.mimeType.startsWith('image/'),
  );
  expect(imageEntries).to.have.length(1);
  const image = await container.readFile(imageEntries[0]!.path);
  expect(image).to.not.equal(null);
  expect(Buffer.from(image ?? new ArrayBuffer(0))).to.deep.equal(Buffer.from(TINY_PNG));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

async function independentDocxFixture(): Promise<Buffer> {
  const archive = new JSZip();
  archive.file('[Content_Types].xml', CONTENT_TYPES_XML);
  archive.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  archive.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>Independent heading</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:rPr><w:b/></w:rPr><w:t>Bold fact</w:t></w:r>
      <w:r><w:t xml:space="preserve"> and </w:t></w:r>
      <w:r><w:rPr><w:i/></w:rPr><w:t>italic detail</w:t></w:r>
    </w:p>
  </w:body>
</w:document>`,
  );
  return archive.generateAsync({ type: 'nodebuffer' });
}

async function independentPptxFixture(): Promise<Buffer> {
  const archive = new JSZip();
  archive.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`,
  );
  archive.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`,
  );
  archive.file(
    'ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000"/>
</p:presentation>`,
  );
  archive.file(
    'ppt/_rels/presentation.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
</Relationships>`,
  );
  archive.file(
    'ppt/slides/slide1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr><a:xfrm/></p:grpSpPr>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Independent slide</a:t></a:r></a:p></p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
      <p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Independent bullet evidence</a:t></a:r></a:p></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>`,
  );
  return archive.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
}

function independentPdfFixture(): Buffer {
  const stream =
    'BT\n/F1 24 Tf\n72 720 Td\n(Independent PDF heading) Tj\n0 -36 Td\n/F1 12 Tf\n(Independent PDF body evidence) Tj\nET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(body, 'ascii'));
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, 'ascii');
  body += `xref\n0 ${objects.length + 1}\n`;
  body += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) {
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'ascii');
}
