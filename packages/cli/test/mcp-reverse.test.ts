/**
 * Reverse-direction MCP tools (X → Markdown).
 *
 * Round-trip coverage is supplemented with independent OOXML and archive
 * safety fixtures so correlated exporter/importer regressions cannot make the
 * entire reverse suite pass accidentally.
 */

import { expect } from 'chai';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { startMcpHarness, callTool, SAMPLE_MARKDOWN, type McpHarness } from './mcp-helpers.js';

const TINY_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6]);

describe('MCP reverse-direction tools', function () {
  this.timeout(60_000);

  let h: McpHarness;
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

  describe('convert_docx_to_markdown', () => {
    it('round-trips markdown → docx → markdown preserving key content', async () => {
      const docxPath = join(h.tmpDir, 'rt.docx');
      await callTool(h.client, 'export_markdown_to_docx', {
        markdown: SAMPLE_MARKDOWN,
        outputPath: docxPath,
      });

      const mdOutPath = join(h.tmpDir, 'rt-from-docx.md');
      const { text, isError } = await callTool(h.client, 'convert_docx_to_markdown', {
        inputPath: docxPath,
        outputPath: mdOutPath,
      });
      expect(isError).to.equal(false);
      expect(text.trim().length).to.be.greaterThan(0);
      expect(text.toLowerCase()).to.include('golden gate bridge');
      expect(text).to.include('1937');
      const onDisk = await readFile(mdOutPath, 'utf-8');
      expect(onDisk).to.equal(text);
    });

    it('imports an independent DOCX fixture with heading and inline emphasis fidelity', async () => {
      const docxPath = join(h.tmpDir, 'independent.docx');
      await writeFile(docxPath, await independentDocxFixture());

      const { text, isError } = await callTool(h.client, 'convert_docx_to_markdown', {
        inputPath: docxPath,
      });
      expect(isError).to.equal(false);
      expect(text).to.include('# Independent heading');
      expect(text).to.include('**Bold fact**');
      expect(text).to.include('*italic detail*');
    });

    it('returns embedded DOCX images as self-contained Markdown data URLs', async () => {
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
      const docxPath = join(h.tmpDir, 'embedded-image.docx');
      await writeFile(docxPath, Buffer.from(docx));

      const { text, isError } = await callTool(h.client, 'convert_docx_to_markdown', {
        inputPath: docxPath,
      });
      expect(isError).to.equal(false);
      const { findNodesByType, parseMarkdown } = await import('@bendyline/squisq/markdown');
      const importedImages = findNodesByType(parseMarkdown(text), 'image');
      expect(importedImages).to.have.length(1);
      expect((importedImages[0] as { url?: string }).url).to.equal(
        `data:image/png;base64,${Buffer.from(TINY_PNG).toString('base64')}`,
      );
      expect(text).to.not.include('images/image1.png');
    });

    it('rejects an OOXML compression bomb through the linked bounded importer', async () => {
      const archive = new JSZip();
      archive.file('[Content_Types].xml', CONTENT_TYPES_XML);
      archive.file('word/document.xml', 'A'.repeat(2 * 1024 * 1024));
      const docxPath = join(h.tmpDir, 'compression-bomb.docx');
      await writeFile(
        docxPath,
        await archive.generateAsync({
          type: 'nodebuffer',
          compression: 'DEFLATE',
          compressionOptions: { level: 9 },
        }),
      );

      const { text, isError } = await callTool(h.client, 'convert_docx_to_markdown', {
        inputPath: docxPath,
      });
      expect(isError).to.equal(true);
      expect(text.toLowerCase()).to.include('compression-ratio');
    });
  });

  describe('convert_pptx_to_markdown', () => {
    it('round-trips markdown → pptx → markdown with `##` slide headings', async () => {
      const pptxPath = join(h.tmpDir, 'rt.pptx');
      await callTool(h.client, 'export_markdown_to_pptx', {
        markdown: SAMPLE_MARKDOWN,
        outputPath: pptxPath,
      });

      const mdOutPath = join(h.tmpDir, 'rt-from-pptx.md');
      const { text, isError } = await callTool(h.client, 'convert_pptx_to_markdown', {
        inputPath: pptxPath,
        outputPath: mdOutPath,
      });
      expect(isError).to.equal(false);
      expect(text.trim().length).to.be.greaterThan(0);
      // PPTX converter emits each slide as `## Title`
      expect(text).to.match(/^## /m);
      // At least some content from the source should survive
      expect(text.toLowerCase()).to.match(/golden gate|introduction|key facts|legacy/);
      expect(await readFile(mdOutPath, 'utf8')).to.equal(text);
    });

    it('returns embedded PPTX images as self-contained Markdown data URLs', async () => {
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
      const pptxPath = join(h.tmpDir, 'embedded-image.pptx');
      await writeFile(pptxPath, Buffer.from(pptx));

      const { text, isError } = await callTool(h.client, 'convert_pptx_to_markdown', {
        inputPath: pptxPath,
      });
      expect(isError).to.equal(false);
      const { findNodesByType, parseMarkdown } = await import('@bendyline/squisq/markdown');
      const importedImages = findNodesByType(parseMarkdown(text), 'image');
      expect(importedImages).to.have.length(1);
      expect((importedImages[0] as { url?: string }).url).to.equal(
        `data:image/png;base64,${Buffer.from(TINY_PNG).toString('base64')}`,
      );
      expect(text).to.not.include('images/image1.png');
    });
  });

  describe('convert_pdf_to_markdown', () => {
    it('heuristically recovers Markdown structure and text from a PDF', async () => {
      const pdfPath = join(h.tmpDir, 'rt.pdf');
      await callTool(h.client, 'export_markdown_to_pdf', {
        markdown: SAMPLE_MARKDOWN,
        outputPath: pdfPath,
      });

      const mdOutPath = join(h.tmpDir, 'rt-from-pdf.md');
      const { text, isError } = await callTool(h.client, 'convert_pdf_to_markdown', {
        inputPath: pdfPath,
        outputPath: mdOutPath,
      });
      expect(isError).to.equal(false);
      expect(text.trim().length).to.be.greaterThan(0);
      expect(text).to.match(/^# /m);
      expect(text).to.match(/^## /m);
      // Expect at least one recognisable phrase from the source.
      expect(text.toLowerCase()).to.match(/golden gate|bridge|1937/);
      expect(await readFile(mdOutPath, 'utf8')).to.equal(text);
    });
  });
});

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
