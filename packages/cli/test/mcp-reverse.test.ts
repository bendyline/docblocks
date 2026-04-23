/**
 * Reverse-direction MCP tools (X → Markdown).
 *
 * Each test first renders the sample markdown to the target format using the
 * forward-direction tool, then feeds the produced file back through the
 * corresponding reverse tool. We assert the result is non-empty markdown that
 * contains key phrases from the original (exact round-trip isn't guaranteed:
 * DOCX adds markup, PPTX rearranges into slides, PDF extraction is lossy).
 */

import { expect } from 'chai';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startMcpHarness, callTool, SAMPLE_MARKDOWN, type McpHarness } from './mcp-helpers.js';

describe('MCP reverse-direction tools', function () {
  this.timeout(60_000);

  let h: McpHarness;

  before(async () => {
    h = await startMcpHarness();
  });

  after(async () => {
    await h.dispose();
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
  });

  describe('convert_pptx_to_markdown', () => {
    it('round-trips markdown → pptx → markdown with `##` slide headings', async () => {
      const pptxPath = join(h.tmpDir, 'rt.pptx');
      await callTool(h.client, 'export_markdown_to_pptx', {
        markdown: SAMPLE_MARKDOWN,
        outputPath: pptxPath,
      });

      const { text, isError } = await callTool(h.client, 'convert_pptx_to_markdown', {
        inputPath: pptxPath,
      });
      expect(isError).to.equal(false);
      expect(text.trim().length).to.be.greaterThan(0);
      // PPTX converter emits each slide as `## Title`
      expect(text).to.match(/^## /m);
      // At least some content from the source should survive
      expect(text.toLowerCase()).to.match(/golden gate|introduction|key facts|legacy/);
    });
  });

  describe('convert_pdf_to_markdown', () => {
    it('extracts text from a PDF into markdown pages', async () => {
      const pdfPath = join(h.tmpDir, 'rt.pdf');
      await callTool(h.client, 'export_markdown_to_pdf', {
        markdown: SAMPLE_MARKDOWN,
        outputPath: pdfPath,
      });

      const { text, isError } = await callTool(h.client, 'convert_pdf_to_markdown', {
        inputPath: pdfPath,
      });
      expect(isError).to.equal(false);
      expect(text.trim().length).to.be.greaterThan(0);
      expect(text).to.match(/^## Page 1\b/m);
      // Expect at least one recognisable phrase from the source.
      expect(text.toLowerCase()).to.match(/golden gate|bridge|1937/);
    });
  });
});
